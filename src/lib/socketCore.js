// src/lib/socketCore.js — cliente REST de socket-core (hub en tiempo real del VPS).
// La API key vive solo aquí (backend). El frontend recibe JWT de 10 min.
//   - emitir(targets, payload): evento al canal, solo a esos socket_id
//   - tokenPara(socketId):      JWT `subscribe` para que el navegador escuche
import { SOCKET_CORE_API_KEY, SOCKET_CORE_CANAL, SOCKET_CORE_URL, socketConfigurado } from "../config.js";

const TIMEOUT_MS = 5000;

async function llamar(ruta, { method = "GET", body } = {}) {
  const res = await fetch(`${SOCKET_CORE_URL}${ruta}`, {
    method,
    headers: { "X-Api-Key": SOCKET_CORE_API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

let canalListo = false;
// Crea el canal si no existe (la key necesita scope `manage`). Idempotente.
export async function asegurarCanal() {
  if (!socketConfigurado() || canalListo) return;
  const r = await llamar("/channels", {
    method: "POST",
    body: { name: SOCKET_CORE_CANAL, description: "Notificaciones de Seventwo" },
  });
  if (r.ok || r.status === 409) canalListo = true;
  else throw new Error(`no se pudo crear el canal (${r.status}): ${r.json?.error ?? ""}`);
}

/** Emite `payload` solo a los `socketIds` indicados. No lanza si no está configurado. */
export async function emitir(socketIds, payload) {
  if (!socketConfigurado() || !socketIds?.length) return { omitido: true };
  const canal = encodeURIComponent(SOCKET_CORE_CANAL);
  const body = { source: "seventwo-backend", targets: socketIds.map(String), payload };
  let r = await llamar(`/channels/${canal}/events`, { method: "POST", body });
  if (r.status === 404) {
    canalListo = false;
    await asegurarCanal();
    r = await llamar(`/channels/${canal}/events`, { method: "POST", body });
  }
  if (!r.ok) throw new Error(`socket-core respondió ${r.status}: ${r.json?.error ?? ""}`);
  return { ok: true };
}

/** JWT de solo escucha para el navegador de un usuario. */
export async function tokenPara(socketId) {
  await asegurarCanal();
  const r = await llamar("/auth/token", {
    method: "POST",
    body: { user_id: String(socketId), channel: SOCKET_CORE_CANAL, role: "subscribe" },
  });
  if (!r.ok || !r.json?.data?.token) throw new Error(`socket-core no emitió token (${r.status})`);
  return { token: r.json.data.token, expires_in: r.json.data.expires_in, channel: SOCKET_CORE_CANAL };
}
