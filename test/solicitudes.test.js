// test/solicitudes.test.js — presupuestos: formulario público, vinculación por
// email, "mis solicitudes", panel del equipo y bandeja de notificaciones.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bandejaPruebas, cliente, iniciar, limpiarBD, pool, ultimoCodigo } from "./helpers.js";

let ctx;
before(async () => { ctx = await iniciar(); });
after(async () => { await ctx.cerrar(); });
beforeEach(limpiarBD);

const PASS = "clave1234";
const esperar = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const FORM = {
  nombre: "Ana Pérez",
  email: "Ana@Empresa.com",
  telefono: "+57 300 123 4567",
  tipo_proyecto: "Aplicación web",
  presupuesto: "Más de $10M COP",
  descripcion: "Necesito una app de reservas para mi barbería con pagos en línea.",
  acepta: true,
  ms: 8000,
};

async function cuenta(nombre, rol = "usuario", { verificar = true } = {}) {
  const email = `${nombre}@ejemplo.com`;
  const api = cliente(ctx.base);
  await api.post("/auth/registro", { name: nombre, email, password: PASS });
  if (verificar) await api.post("/auth/verificar-email", { email, codigo: ultimoCodigo(email) });
  const { rows: [u] } = await pool.query("UPDATE usuarios SET rol = $2 WHERE email = $1 RETURNING id", [email, rol]);
  await pool.query("DELETE FROM rate_limits");
  if (!verificar) return { api, id: u.id, email };
  const r = await api.post("/auth/login", { email, password: PASS });
  return { api, id: u.id, email, token: r.body.data.accessToken };
}

describe("formulario público", () => {
  test("crea la solicitud, confirma al solicitante y avisa al equipo (bandeja + buzón)", async () => {
    const admin = await cuenta("adm", "admin");
    const sup = await cuenta("sup", "superadmin");
    bandejaPruebas.length = 0;

    const r = await cliente(ctx.base).post("/solicitudes", FORM);
    assert.equal(r.status, 201);
    assert.match(r.body.data.codigo, /^S-\d{4,}$/);
    assert.equal(r.body.data.tieneCuenta, undefined, "no revela si el email tiene cuenta");
    await esperar();

    const { rows: [s] } = await pool.query("SELECT * FROM solicitudes");
    assert.equal(s.email, "ana@empresa.com");
    assert.equal(s.usuario_id, null);
    assert.equal(s.estado, "nueva");
    assert.equal(s.origen, "web");

    const confirmacion = bandejaPruebas.find((m) => m.to === "ana@empresa.com");
    assert.match(confirmacion.subject, new RegExp(`Recibimos tu solicitud ${s.codigo}`));
    assert.equal(confirmacion.replyTo, "info@seventwo.tech");
    assert.match(confirmacion.html, /registro\?email=ana%40empresa\.com/, "invita a crear cuenta");
    const equipo = bandejaPruebas.find((m) => m.to === "info@seventwo.tech");
    assert.match(equipo.subject, /Nueva solicitud/);
    assert.equal(equipo.replyTo, "ana@empresa.com");

    const { rows: notifs } = await pool.query("SELECT usuario_id, tipo, url FROM notificaciones ORDER BY usuario_id");
    assert.deepEqual(notifs.map((n) => n.usuario_id), [admin.id, sup.id]);
    assert.equal(notifs[0].tipo, "solicitud_nueva");
    assert.equal(notifs[0].url, `/admin?solicitud=${s.id}`);
  });

  test("validación: tipo, descripción, consentimiento, email y teléfono", async () => {
    const api = cliente(ctx.base);
    // El límite por IP (5/h) cuenta también los envíos inválidos: se limpia entre casos.
    const probar = async (cambio) => {
      await pool.query("DELETE FROM rate_limits");
      return (await api.post("/solicitudes", { ...FORM, ...cambio })).status;
    };
    assert.equal(await probar({ tipo_proyecto: "Cohete" }), 400);
    assert.equal(await probar({ descripcion: "corto" }), 400);
    assert.equal(await probar({ acepta: false }), 400);
    assert.equal(await probar({ email: "no-es-email" }), 400);
    assert.equal(await probar({ telefono: "abc" }), 400);
    assert.equal(await probar({ presupuesto: "Un millón" }), 400);
  });

  test("anti-bots: campo trampa o envío instantáneo → OK falso sin guardar", async () => {
    const api = cliente(ctx.base);
    const a = await api.post("/solicitudes", { ...FORM, website: "http://spam" });
    const b = await api.post("/solicitudes", { ...FORM, ms: 500 });
    assert.equal(a.status, 201);
    assert.equal(b.body.data.codigo, "S-0000");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM solicitudes");
    assert.equal(rows[0].n, 0);
  });

  test("rate limit: 3 por email al día", async () => {
    const st = [];
    for (let i = 0; i < 4; i++) st.push((await cliente(ctx.base).post("/solicitudes", FORM)).status);
    assert.deepEqual(st, [201, 201, 201, 429]);
  });

  test("con sesión usa nombre y email de la cuenta y queda vinculada", async () => {
    const u = await cuenta("usu");
    const r = await u.api.post("/solicitudes", { ...FORM, email: "otro@x.com", nombre: "Falso" }, { token: u.token });
    assert.equal(r.body.data.email, u.email);
    const { rows: [s] } = await pool.query("SELECT * FROM solicitudes");
    assert.equal(s.usuario_id, u.id);
    assert.equal(s.nombre, "usu");
    assert.equal(s.origen, "area_cliente");
  });
});

describe("vinculación por email", () => {
  test("solicitud sin cuenta → al registrarse y VERIFICAR el email aparece en Mis solicitudes", async () => {
    await cliente(ctx.base).post("/solicitudes", { ...FORM, email: "nuevo@ejemplo.com" });
    const api = cliente(ctx.base);
    await api.post("/auth/registro", { name: "Nuevo", email: "nuevo@ejemplo.com", password: PASS });
    let { rows: [s] } = await pool.query("SELECT usuario_id FROM solicitudes");
    assert.equal(s.usuario_id, null, "sin verificar no se vincula");

    const v = await api.post("/auth/verificar-email", { email: "nuevo@ejemplo.com", codigo: ultimoCodigo("nuevo@ejemplo.com") });
    const mias = await api.get("/solicitudes/mias", { token: v.body.data.accessToken });
    assert.equal(mias.body.data.length, 1);
    assert.equal(mias.body.data[0].tipo_proyecto, "Aplicación web");
  });

  test("si el email ya es de una cuenta verificada, se vincula al momento", async () => {
    const u = await cuenta("ver");
    await cliente(ctx.base).post("/solicitudes", { ...FORM, email: u.email });
    const mias = await u.api.get("/solicitudes/mias", { token: u.token });
    assert.equal(mias.body.data.length, 1);
  });
});

describe("mis solicitudes (IDOR)", () => {
  test("nadie ve ni responde solicitudes ajenas", async () => {
    const a = await cuenta("aaa");
    const b = await cuenta("bbb");
    const r = await a.api.post("/solicitudes", FORM, { token: a.token });
    const codigo = r.body.data.codigo;
    assert.equal((await b.api.get(`/solicitudes/mias/${codigo}`, { token: b.token })).status, 404);
    assert.equal((await b.api.post(`/solicitudes/mias/${codigo}/mensajes`, { cuerpo: "hola" }, { token: b.token })).status, 404);
    assert.equal((await b.api.get("/solicitudes/mias", { token: b.token })).body.data.length, 0);
    assert.equal((await a.api.get(`/solicitudes/mias/${codigo.toLowerCase()}`, { token: a.token })).status, 200);
    assert.equal((await a.api.get("/solicitudes/mias")).status, 401);
  });
});

describe("panel del equipo y conversación", () => {
  test("ver pasa a en_revision; responder avisa por email; las notas internas no salen", async () => {
    const adm = await cuenta("adm", "admin");
    const u = await cuenta("usu");
    const { body } = await u.api.post("/solicitudes", FORM, { token: u.token });
    const { rows: [{ id }] } = await pool.query("SELECT id FROM solicitudes");

    assert.equal((await u.api.get("/admin/solicitudes", { token: u.token })).status, 403);
    const lista = await adm.api.get("/admin/solicitudes", { token: adm.token });
    assert.equal(lista.body.data.total, 1);
    assert.equal(lista.body.data.conteos.nueva, 1);

    const det = await adm.api.get(`/admin/solicitudes/${id}`, { token: adm.token });
    assert.equal(det.body.data.estado, "en_revision");
    assert.equal(det.body.data.asignado_a, adm.id);
    assert.equal(det.body.data.ip, undefined, "no expone IP");

    await adm.api.post(`/admin/solicitudes/${id}/mensajes`, { cuerpo: "Nota: cliente interesante", interno: true }, { token: adm.token });
    bandejaPruebas.length = 0;
    const resp = await adm.api.post(`/admin/solicitudes/${id}/mensajes`, { cuerpo: "Hola, te proponemos dos opciones." }, { token: adm.token });
    assert.equal(resp.body.data.estado, "respondida");
    await esperar();
    const email = bandejaPruebas.find((m) => m.to === u.email);
    assert.match(email.subject, /respondió a tu solicitud/);
    assert.match(email.text, /dos opciones/);

    const mia = await u.api.get(`/solicitudes/mias/${body.data.codigo}`, { token: u.token });
    assert.deepEqual(mia.body.data.mensajes.map((m) => m.cuerpo), ["Hola, te proponemos dos opciones."]);
    assert.equal(mia.body.data.mensajes[0].autor, "adm");

    const { rows: n } = await pool.query("SELECT tipo FROM notificaciones WHERE usuario_id = $1 ORDER BY id", [u.id]);
    assert.deepEqual(n.map((x) => x.tipo), ["solicitud_recibida", "solicitud_respondida"]);
  });

  test("el cliente contesta → vuelve a en_revision y avisa al equipo", async () => {
    const adm = await cuenta("adm", "admin");
    const u = await cuenta("usu");
    const { body } = await u.api.post("/solicitudes", FORM, { token: u.token });
    const { rows: [{ id }] } = await pool.query("SELECT id FROM solicitudes");
    await adm.api.post(`/admin/solicitudes/${id}/mensajes`, { cuerpo: "¿Para cuándo lo necesitas?" }, { token: adm.token });

    const r = await u.api.post(`/solicitudes/mias/${body.data.codigo}/mensajes`, { cuerpo: "Para diciembre." }, { token: u.token });
    assert.equal(r.status, 201);
    await esperar();
    const { rows: [s] } = await pool.query("SELECT estado FROM solicitudes");
    assert.equal(s.estado, "en_revision");
    const { rows: n } = await pool.query("SELECT tipo FROM notificaciones WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1", [adm.id]);
    assert.equal(n[0].tipo, "solicitud_mensaje_cliente");
  });

  test("estado y asignado: valida y avisa al aceptar", async () => {
    const adm = await cuenta("adm", "admin");
    const u = await cuenta("usu");
    await cliente(ctx.base).post("/solicitudes", { ...FORM, email: "x@sin-cuenta.com" });
    const { rows: [{ id }] } = await pool.query("SELECT id FROM solicitudes");

    assert.equal((await adm.api.patch(`/admin/solicitudes/${id}`, { estado: "volando" }, { token: adm.token })).status, 400);
    assert.equal((await adm.api.patch(`/admin/solicitudes/${id}`, { asignado_a: u.id }, { token: adm.token })).status, 400);
    bandejaPruebas.length = 0;
    const r = await adm.api.patch(`/admin/solicitudes/${id}`, { estado: "aceptada" }, { token: adm.token });
    assert.equal(r.body.data.estado, "aceptada");
    await esperar();
    assert.match(bandejaPruebas.find((m) => m.to === "x@sin-cuenta.com").subject, /Aceptada/);
  });

  test("archivadas no salen en la lista por defecto; filtro y búsqueda", async () => {
    const adm = await cuenta("adm", "admin");
    await cliente(ctx.base).post("/solicitudes", { ...FORM, email: "uno@x.com", nombre: "Uno" });
    await pool.query("DELETE FROM rate_limits");
    await cliente(ctx.base).post("/solicitudes", { ...FORM, email: "dos@x.com", nombre: "Dos" });
    await pool.query("UPDATE solicitudes SET estado = 'archivada' WHERE email = 'dos@x.com'");
    assert.equal((await adm.api.get("/admin/solicitudes", { token: adm.token })).body.data.total, 1);
    assert.equal((await adm.api.get("/admin/solicitudes?estado=archivada", { token: adm.token })).body.data.total, 1);
    assert.equal((await adm.api.get("/admin/solicitudes?buscar=uno@", { token: adm.token })).body.data.total, 1);
  });
});

describe("notificaciones", () => {
  test("bandeja propia, contador y marcar leídas sin tocar las ajenas", async () => {
    const a = await cuenta("adm", "admin");
    const b = await cuenta("sup", "superadmin");
    await cliente(ctx.base).post("/solicitudes", FORM);
    await esperar();

    const ra = await a.api.get("/notificaciones", { token: a.token });
    assert.equal(ra.body.data.no_leidas, 1);
    const idA = ra.body.data.notificaciones[0].id;
    const { rows: [nb] } = await pool.query("SELECT id FROM notificaciones WHERE usuario_id = $1", [b.id]);

    // Intentar marcar la de B con la sesión de A no hace nada.
    assert.equal((await a.api.post("/notificaciones/leer", { ids: [nb.id] }, { token: a.token })).body.data.marcadas, 0);
    assert.equal((await a.api.post("/notificaciones/leer", { ids: [idA] }, { token: a.token })).body.data.marcadas, 1);
    assert.equal((await a.api.get("/notificaciones", { token: a.token })).body.data.no_leidas, 0);
    assert.equal((await b.api.get("/notificaciones", { token: b.token })).body.data.no_leidas, 1);
    assert.equal((await a.api.post("/notificaciones/leer", { ids: ["x"] }, { token: a.token })).status, 400);
    assert.equal(typeof idA, "string", "pg devuelve BIGSERIAL como texto: el front lo reenvía así");
  });

  test("sin configurar: socket-token y push responden 503; config lo indica", async () => {
    const u = await cuenta("usu");
    const cfg = await u.api.get("/notificaciones/config", { token: u.token });
    assert.deepEqual(cfg.body.data, { socket: false, push: false, vapidPublicKey: null });
    assert.equal((await u.api.post("/notificaciones/socket-token", null, { token: u.token })).status, 503);
    assert.equal((await u.api.post("/notificaciones/push", { endpoint: "https://x", keys: { p256dh: "a", auth: "b" } }, { token: u.token })).status, 503);
  });
});
