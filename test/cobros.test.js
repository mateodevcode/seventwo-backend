// test/cobros.test.js — F3 de docs/CLIENTES.md: mensualidades automáticas (con
// historial silencioso), pagos del equipo (uno y en lote), comprobantes del
// cliente (verificar/rechazar), recordatorios, vencidos y aislamiento.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bandejaPruebas, cliente, iniciar, limpiarBD, pool, ultimoCodigo } from "./helpers.js";
import { memoriaPruebas } from "../src/lib/almacen.js";
import { avisarCobros, generarCobrosRecurrentes } from "../src/services/cobros.service.js";

let ctx;
before(async () => { ctx = await iniciar(); });
after(async () => { await ctx.cerrar(); });
beforeEach(async () => {
  await limpiarBD();
  memoriaPruebas.clear();
});

const PASS = "clave1234";
const esperar = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

async function cuenta(nombre, rol = "usuario") {
  const email = `${nombre}@ejemplo.com`;
  const api = cliente(ctx.base);
  await api.post("/auth/registro", { name: `${nombre} Pérez`, email, password: PASS });
  await api.post("/auth/verificar-email", { email, codigo: ultimoCodigo(email) });
  const { rows: [u] } = await pool.query("UPDATE usuarios SET rol = $2 WHERE email = $1 RETURNING id", [email, rol]);
  await pool.query("DELETE FROM rate_limits");
  const r = await api.post("/auth/login", { email, password: PASS });
  return { api, id: u.id, email, token: r.body.data.accessToken };
}

/** Fecha (Bogotá) desplazada `meses` desde hoy. */
async function fechaRel(meses, dias = 0) {
  const { rows: [r] } = await pool.query(
    `SELECT ((now() AT TIME ZONE 'America/Bogota')::date + make_interval(months => $1::int, days => $2::int))::date AS f`,
    [meses, dias],
  );
  return r.f;
}

async function crudo(token, ruta, body, tipo = "image/png") {
  const res = await fetch(`${ctx.base}${ruta}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": tipo }, body });
  return { status: res.status, body: await res.json() };
}

/** Cliente con suscripción mensual de $54.000 cuyo primer cobro fue hace 3 meses. */
async function preparar() {
  const adm = await cuenta("adm", "admin");
  const ceci = await cuenta("ceci");
  const { body: { data: c } } = await adm.api.post("/admin/clientes", { email: ceci.email, nombre: "Doña Ceci Congelados S.A.S." }, { token: adm.token });
  bandejaPruebas.length = 0;
  const r = await adm.api.post("/admin/proyectos", {
    cliente_id: c.id, nombre: "Carta digital", estado: "mantenimiento", modelo_cobro: "recurrente",
    importe_periodo: 54000, periodicidad: "mensual", proximo_cobro: await fechaRel(-3), recordatorio_dias: 3, avisar: false,
  }, { token: adm.token });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await esperar();
  return { adm, ceci, c, p: r.body.data };
}

const cobrosDe = async (pid) => (await pool.query("SELECT * FROM cobros WHERE proyecto_id = $1 ORDER BY fecha_vencimiento", [pid])).rows;

describe("cobros recurrentes", () => {
  test("al crear el proyecto genera el historial en silencio y la mensualidad actual; es idempotente", async () => {
    const { p } = await preparar();
    const cobros = await cobrosDe(p.id);
    assert.equal(cobros.length, 4, "3 pasados + el de hoy");
    assert.deepEqual(cobros.map((c) => c.importe), [54000, 54000, 54000, 54000]);
    assert.ok(cobros.slice(0, 3).every((c) => c.recordatorio_enviado_en && c.vencido_avisado_en), "historial sin avisos");
    assert.equal(cobros[3].recordatorio_enviado_en, null);
    assert.equal(cobros[3].fecha_vencimiento, await fechaRel(0));
    assert.match(cobros[0].concepto, /^Carta digital · \d+ \w+ \d{4} – \d+ \w+ \d{4}$/);
    assert.equal(bandejaPruebas.length, 0, "no se escribe al cliente (avisar: false)");

    const { rows: [proy] } = await pool.query("SELECT proximo_cobro FROM proyectos WHERE id = $1", [p.id]);
    assert.equal(proy.proximo_cobro, await fechaRel(1));
    assert.equal(await generarCobrosRecurrentes(), 0);
    assert.equal((await cobrosDe(p.id)).length, 4);
  });

  test("recordatorio N días antes (una vez) y vencidos al equipo y al cliente", async () => {
    const { adm, ceci, p } = await preparar();
    let r = await avisarCobros();
    assert.deepEqual(r, { recordatorios: 1, vencidos: 3 - 3 });
    await esperar();
    const rec = bandejaPruebas.find((m) => m.to === ceci.email);
    assert.match(rec.subject, /Recordatorio: tu pago de \$ 54\.000 vence/);
    r = await avisarCobros();
    assert.deepEqual(r, { recordatorios: 0, vencidos: 0 }, "no repite");

    // Un cobro manual que venció ayer → aviso de vencido.
    await adm.api.post(`/admin/proyectos/${p.id}/cobros`, { concepto: "Ajuste de diseño", importe: 120000, fecha_vencimiento: await fechaRel(0, -1) }, { token: adm.token });
    bandejaPruebas.length = 0;
    r = await avisarCobros();
    assert.equal(r.vencidos, 1);
    await esperar();
    assert.ok(bandejaPruebas.some((m) => m.to === ceci.email && /está pendiente/.test(m.subject)));
    const { rows } = await pool.query("SELECT tipo FROM notificaciones WHERE usuario_id = $1", [adm.id]);
    assert.ok(rows.some((n) => n.tipo === "cobro_vencido"));
  });
});

describe("pagos", () => {
  test("pagar en lote el historial en sus fechas; el estado de cuenta solo deja lo pendiente", async () => {
    const { adm, ceci, p } = await preparar();
    const cobros = await cobrosDe(p.id);
    const r = await adm.api.post("/admin/cobros/pagar-lote", { cobro_ids: cobros.slice(0, 3).map((c) => c.id), via: "mercadopago", fecha: "vencimiento" }, { token: adm.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const despues = await cobrosDe(p.id);
    assert.deepEqual(despues.map((c) => c.estado), ["pagado", "pagado", "pagado", "pendiente"]);
    assert.equal(despues[0].pagado_en, despues[0].fecha_vencimiento);
    const { rows: pagos } = await pool.query("SELECT via, fecha_pago, estado FROM pagos ORDER BY fecha_pago");
    assert.equal(pagos.length, 3);
    assert.ok(pagos.every((x) => x.via === "mercadopago" && x.estado === "confirmado"));

    const mios = await ceci.api.get("/cobros/mios", { token: ceci.token });
    assert.equal(mios.body.data.cuenta.pendiente, 54000);
    assert.equal(mios.body.data.cobros.length, 4);
    assert.equal(mios.body.data.cobros[1].pagos[0].notas, undefined, "sin campos internos");
    // Repetir el lote no duplica pagos.
    await adm.api.post("/admin/cobros/pagar-lote", { cobro_ids: cobros.slice(0, 3).map((c) => c.id), via: "nequi" }, { token: adm.token });
    assert.equal((await pool.query("SELECT 1 FROM pagos")).rowCount, 3);
  });

  test("el cliente sube comprobante → en verificación → el equipo confirma; segundo comprobante bloqueado", async () => {
    const { adm, ceci, p } = await preparar();
    const actual = (await cobrosDe(p.id))[3];
    const sub = await crudo(ceci.token, `/cobros/mios/${actual.codigo}/comprobante?via=nequi&referencia=M12345&nombre=nequi.png`, PNG);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    await esperar();
    assert.ok(bandejaPruebas.some((m) => m.to === "info@seventwo.tech" && /subió un comprobante/.test(m.subject)));
    let c = (await cobrosDe(p.id))[3];
    assert.equal(c.estado, "pendiente", "no cuenta hasta confirmarlo");
    const { rows: [a] } = await pool.query("SELECT s3_clave, mime FROM archivos");
    assert.match(a.s3_clave, /^seventwo\/privado\/comprobantes\/\d+\//);
    assert.equal(a.mime, "image/png");

    assert.equal((await crudo(ceci.token, `/cobros/mios/${actual.codigo}/comprobante?via=nequi`, PNG)).status, 409);

    const panel = await adm.api.get("/admin/cobros", { token: adm.token });
    assert.equal(panel.body.data.verificar.length, 1);
    const ok = await adm.api.post(`/admin/pagos/${sub.body.data.id}/confirmar`, {}, { token: adm.token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    c = (await cobrosDe(p.id))[3];
    assert.equal(c.estado, "pagado");
    const url = await ceci.api.get(`/pagos/${sub.body.data.id}/comprobante`, { token: ceci.token });
    assert.match(url.body.data.url, /^memoria:\/\//);
  });

  test("rechazo con motivo: vuelve a pendiente y el cliente recibe el email", async () => {
    const { adm, ceci, p } = await preparar();
    const actual = (await cobrosDe(p.id))[3];
    const sub = await crudo(ceci.token, `/cobros/mios/${actual.codigo}/comprobante?via=transferencia`, PNG);
    bandejaPruebas.length = 0;
    assert.equal((await adm.api.post(`/admin/pagos/${sub.body.data.id}/rechazar`, {}, { token: adm.token })).status, 400);
    const r = await adm.api.post(`/admin/pagos/${sub.body.data.id}/rechazar`, { motivo: "El valor no coincide" }, { token: adm.token });
    assert.equal(r.status, 200);
    await esperar();
    assert.ok(bandejaPruebas.some((m) => m.to === ceci.email && /No pudimos confirmar/.test(m.subject)));
    assert.equal((await cobrosDe(p.id))[3].estado, "pendiente");
    // Puede volver a intentarlo.
    assert.equal((await crudo(ceci.token, `/cobros/mios/${actual.codigo}/comprobante?via=transferencia`, PNG)).status, 201);
  });

  test("adjuntar la foto a un pago ya registrado (cliente o equipo); tipo real y dueño", async () => {
    const { adm, ceci, p } = await preparar();
    const [c1] = await cobrosDe(p.id);
    await adm.api.post(`/admin/cobros/${c1.id}/pagos`, { fecha_pago: c1.fecha_vencimiento, via: "nequi" }, { token: adm.token });
    const { rows: [pg] } = await pool.query("SELECT id FROM pagos");

    assert.equal((await crudo(ceci.token, `/pagos/${pg.id}/comprobante`, Buffer.from("no es una imagen de verdad"), "image/png")).status, 400);
    assert.equal((await crudo(ceci.token, `/pagos/${pg.id}/comprobante`, PNG)).status, 200);
    assert.equal((await crudo(ceci.token, `/pagos/${pg.id}/comprobante`, PNG)).status, 409, "el cliente no reemplaza");
    assert.equal((await crudo(adm.token, `/admin/pagos/${pg.id}/comprobante`, PNG)).status, 200, "el equipo sí");
    assert.equal(memoriaPruebas.size, 1, "el anterior se borra de S3");

    const otro = await cuenta("otro");
    await adm.api.post("/admin/clientes", { email: otro.email, nombre: "Otro" }, { token: adm.token });
    await pool.query("DELETE FROM rate_limits");
    assert.equal((await otro.api.get(`/pagos/${pg.id}/comprobante`, { token: otro.token })).status, 404);
    assert.equal((await crudo(otro.token, `/cobros/mios/${c1.codigo}/comprobante?via=nequi`, PNG)).status, 404);
    assert.equal((await ceci.api.get("/admin/cobros", { token: ceci.token })).status, 403);
  });

  test("cobro manual: pago parcial, tope de lo pendiente y anulación", async () => {
    const { adm, p } = await preparar();
    const { body: { data: c } } = await adm.api.post(`/admin/proyectos/${p.id}/cobros`, { concepto: "Módulo de reservas", importe: 300000, fecha_vencimiento: await fechaRel(1) }, { token: adm.token });
    assert.equal((await adm.api.post(`/admin/cobros/${c.id}/pagos`, { fecha_pago: await fechaRel(0), via: "transferencia", importe: 400000 }, { token: adm.token })).status, 400);
    await adm.api.post(`/admin/cobros/${c.id}/pagos`, { fecha_pago: await fechaRel(0), via: "transferencia", importe: 100000 }, { token: adm.token });
    const { rows: [x] } = await pool.query("SELECT estado FROM cobros WHERE id = $1", [c.id]);
    assert.equal(x.estado, "parcial");
    assert.equal((await adm.api.post(`/admin/cobros/${c.id}/anular`, { motivo: "Error" }, { token: adm.token })).status, 409);

    const { body: { data: c2 } } = await adm.api.post(`/admin/proyectos/${p.id}/cobros`, { concepto: "Duplicado", importe: 1000, fecha_vencimiento: await fechaRel(1) }, { token: adm.token });
    assert.equal((await adm.api.post(`/admin/cobros/${c2.id}/anular`, { motivo: "Creado por error" }, { token: adm.token })).status, 200);
  });

  test("bienvenida formal al cliente sin cuenta con enlace de registro", async () => {
    const adm = await cuenta("adm", "admin");
    const { body: { data: c } } = await adm.api.post("/admin/clientes", { email: "nueva@empresa.co", nombre: "Empresa Nueva S.A.S.", contacto_nombre: "Thompson" }, { token: adm.token });
    bandejaPruebas.length = 0;
    assert.equal((await adm.api.post(`/admin/clientes/${c.id}/bienvenida`, {}, { token: adm.token })).status, 200);
    await esperar();
    const m = bandejaPruebas.find((x) => x.to === "nueva@empresa.co");
    assert.match(m.subject, /Bienvenido a tu espacio de cliente/);
    assert.match(m.html, /Hola Thompson/);
    assert.match(m.html, /registro\?email=nueva%40empresa\.co/);
  });
});
