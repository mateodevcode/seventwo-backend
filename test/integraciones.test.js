// test/integraciones.test.js — socket-core y Telegram con la red simulada.
// node:test ejecuta cada archivo en su propio proceso: aquí activamos esos
// canales ANTES de importar src/ (config.js lee el entorno al cargarse).
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.SOCKET_CORE_URL = "http://socket.test";
process.env.SOCKET_CORE_API_KEY = "sc_live_prueba";
process.env.SOCKET_CORE_CANAL = "seventwo:notificaciones";
process.env.TELEGRAM_BOT_TOKEN = "123:ABC";
process.env.TELEGRAM_CHAT_ID = "-1001";

const { iniciar, limpiarBD, pool } = await import("./helpers.js");
const { notificar } = await import("../src/services/notificaciones.service.js");
const socketCore = await import("../src/lib/socketCore.js");

const fetchReal = globalThis.fetch;
let llamadas;
let canalExiste;

let ctx;
before(async () => { ctx = await iniciar(); });
after(async () => { globalThis.fetch = fetchReal; await ctx.cerrar(); });
beforeEach(async () => {
  await limpiarBD();
  llamadas = [];
  canalExiste = false;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith("http://socket.test") && !u.startsWith("https://api.telegram.org")) return fetchReal(url, opts);
    const body = opts.body ? JSON.parse(opts.body) : null;
    llamadas.push({ url: u, method: opts.method, headers: opts.headers, body });
    if (u.endsWith("/channels") && opts.method === "POST") {
      canalExiste = true;
      return Response.json({ success: true, data: { name: body.name } });
    }
    if (u.includes("/events")) {
      return canalExiste ? Response.json({ success: true }) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (u.endsWith("/auth/token")) {
      return Response.json({ success: true, data: { token: "eyJ.prueba", expires_in: 600, channel: body.channel, role: body.role } });
    }
    if (u.includes("api.telegram.org")) return Response.json({ ok: true });
    return Response.json({}, { status: 500 });
  };
});

test("notificar: BD + socket-core (dirigido por socket_id, crea el canal si falta) + Telegram", async () => {
  const { rows: [u] } = await pool.query(
    "INSERT INTO usuarios (name, email, rol) VALUES ('Adm', 'adm@x.com', 'admin') RETURNING id, socket_id",
  );
  const r = await notificar({
    usuarios: [u],
    tipo: "solicitud_nueva",
    titulo: "Nueva solicitud S-0001",
    cuerpo: "Ana · App",
    url: "/admin?solicitud=1",
    telegram: { html: "🆕 <b>Nueva</b>", boton: { texto: "Abrir", url: "https://seventwo.tech/admin?solicitud=1" } },
  });
  assert.deepEqual(r, { bd: "1", socket: "ok", push: "omitido", email: "omitido", telegram: "ok" });

  const eventos = llamadas.filter((l) => l.url.includes("/events"));
  assert.equal(eventos.length, 2, "1º 404 → crea canal → reintenta");
  assert.ok(llamadas.some((l) => l.url.endsWith("/channels") && l.body.name === "seventwo:notificaciones"));
  const ev = eventos[1];
  assert.equal(ev.headers["X-Api-Key"], "sc_live_prueba");
  assert.deepEqual(ev.body.targets, [u.socket_id], "solo al socket_id del destinatario, nunca al id ni al email");
  assert.equal(ev.body.payload.notificacion.titulo, "Nueva solicitud S-0001");

  const tg = llamadas.find((l) => l.url.includes("api.telegram.org"));
  assert.match(tg.url, /bot123:ABC\/sendMessage$/);
  assert.equal(tg.body.chat_id, "-1001");
  assert.equal(tg.body.parse_mode, "HTML");
  assert.equal(tg.body.reply_markup.inline_keyboard[0][0].url, "https://seventwo.tech/admin?solicitud=1");
});

test("un canal que falla no tumba a los demás", async () => {
  const { rows: [u] } = await pool.query(
    "INSERT INTO usuarios (name, email, rol) VALUES ('Adm', 'adm@x.com', 'admin') RETURNING id, socket_id",
  );
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) =>
    String(url).includes("api.telegram.org") ? Response.json({ description: "bot bloqueado" }, { status: 403 }) : original(url, opts);
  const r = await notificar({ usuarios: [u], tipo: "x", titulo: "T", telegram: { html: "hola" } });
  assert.equal(r.telegram, "error");
  assert.equal(r.socket, "ok");
  assert.equal(r.bd, "1");
});

test("socket-token: JWT de solo escucha para el socket_id del usuario", async () => {
  const t = await socketCore.tokenPara("3f0c2c4e-0000-4000-8000-000000000000");
  assert.equal(t.token, "eyJ.prueba");
  const pedido = llamadas.find((l) => l.url.endsWith("/auth/token"));
  assert.deepEqual(pedido.body, {
    user_id: "3f0c2c4e-0000-4000-8000-000000000000",
    channel: "seventwo:notificaciones",
    role: "subscribe",
  });
});

test("Telegram no añade botón con URLs http (lo rechazaría)", async () => {
  const { enviarTelegram } = await import("../src/lib/telegram.js");
  await enviarTelegram("hola", { texto: "Abrir", url: "http://localhost:3000/admin" });
  const tg = llamadas.find((l) => l.url.includes("api.telegram.org"));
  assert.equal(tg.body.reply_markup, undefined);
});
