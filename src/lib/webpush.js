// src/lib/webpush.js — notificaciones push a la PWA instalada (VAPID).
import * as webpush from "web-push"; // v4: ESM con exports nombrados
import { pool } from "../db.js";
import { VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT, pushConfigurado } from "../config.js";

let configurado = false;
const configurar = () => {
  if (!configurado) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configurado = true;
  }
};

/**
 * Envía `payload` ({ title, body, url, tag }) a todos los dispositivos de los usuarios.
 * Borra las suscripciones caducadas (404/410).
 */
export async function enviarPush(usuarioIds, payload) {
  if (!pushConfigurado() || !usuarioIds?.length) return { omitido: true };
  configurar();
  const { rows } = await pool.query(
    "SELECT id, endpoint, p256dh, auth FROM push_suscripciones WHERE usuario_id = ANY($1::int[])",
    [usuarioIds],
  );
  const datos = JSON.stringify(payload);
  const resultados = await Promise.allSettled(
    rows.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          datos,
          { TTL: 24 * 60 * 60, urgency: "high" },
        );
        await pool.query("UPDATE push_suscripciones SET ultimo_uso = now() WHERE id = $1", [s.id]);
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await pool.query("DELETE FROM push_suscripciones WHERE id = $1", [s.id]);
          return;
        }
        throw error;
      }
    }),
  );
  const fallos = resultados.filter((r) => r.status === "rejected");
  if (fallos.length) throw new Error(`${fallos.length}/${rows.length} push fallaron: ${fallos[0].reason?.message}`);
  return { enviados: rows.length };
}
