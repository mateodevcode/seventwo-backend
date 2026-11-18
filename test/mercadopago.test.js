// test/mercadopago.test.js — F4: Checkout Pro y webhook firmado (red de MP simulada).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { cliente, iniciar, limpiarBD, pool, ultimoCodigo } from "./helpers.js";
import { _usarFetchPruebas } from "../src/lib/mercadopago.js";
import { contrastar } from "../src/lib/lectorComprobantes.js";

let ctx;
before(async () => { ctx = await iniciar(); });
after(async () => { await ctx.cerrar(); });
beforeEach(limpiarBD);

const PASS = "clave1234";
const SECRETO = process.env.MP_WEBHOOK_SECRET;
let pagosMp = {};
let preferencias = [];
_usarFetchPruebas(async (url, opts) => {
  const resp = (status, body) => ({ ok: status < 400, status, json: async () => body });
  if (url.endsWith("/checkout/preferences")) {
    preferencias.push(JSON.parse(opts.body));
    return resp(201, { id: "pref-1", init_point: "https://mp/real", sandbox_init_point: "https://mp/sandbox" });
  }
  const id = url.match(/\/v1\/payments\/(.+)$/)?.[1];
  if (id && pagosMp[id]) return resp(200, pagosMp[id]);
  return resp(404, { message: "not found" });
});

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

function firmar(dataId, requestId = "req-1", ts = Date.now()) {
  const v1 = crypto.createHmac("sha256", SECRETO).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest("hex");
  return { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId };
}

async function webhook(dataId, headers) {
  const res = await fetch(`${ctx.base}/webhooks/mercadopago?type=payment&data.id=${dataId}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ type: "payment", data: { id: dataId } }),
  });
  return { status: res.status, body: await res.json() };
}

async function preparar() {
  pagosMp = {};
  preferencias = [];
  const adm = await cuenta("adm", "admin");
  const ceci = await cuenta("ceci");
  const { body: { data: c } } = await adm.api.post("/admin/clientes", { email: ceci.email, nombre: "Doña Ceci" }, { token: adm.token });
  const { body: { data: p } } = await adm.api.post("/admin/proyectos", { cliente_id: c.id, nombre: "Carta", estado: "mantenimiento", avisar: false }, { token: adm.token });
  const { body: { data: cobro } } = await adm.api.post(`/admin/proyectos/${p.id}/cobros`, { concepto: "Mensualidad", importe: 54000, fecha_vencimiento: "2026-12-16" }, { token: adm.token });
  return { adm, ceci, cobro };
}

describe("Mercado Pago", () => {
  test("preferencia por lo pendiente y webhook aprobado → pago confirmado (idempotente)", async () => {
    const { ceci, cobro } = await preparar();
    const r = await ceci.api.post(`/cobros/mios/${cobro.codigo}/mercadopago`, {}, { token: ceci.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.url, "https://mp/sandbox", "token TEST- → sandbox");
    assert.equal(preferencias[0].items[0].unit_price, 54000);
    assert.equal(preferencias[0].external_reference, `cobro:${cobro.id}`);
    assert.match(preferencias[0].notification_url, /\/webhooks\/mercadopago$/);

    pagosMp["111"] = { id: 111, status: "approved", external_reference: `cobro:${cobro.id}`, transaction_amount: 54000, currency_id: "COP", date_approved: "2026-12-15T10:00:00Z" };
    const w = await webhook("111", firmar("111"));
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const { rows: [c] } = await pool.query("SELECT estado, pagado_en FROM cobros WHERE id = $1", [cobro.id]);
    assert.equal(c.estado, "pagado");
    assert.equal(c.pagado_en, "2026-12-15");
    await webhook("111", firmar("111", "req-2"));
    assert.equal((await pool.query("SELECT 1 FROM pagos")).rowCount, 1, "no duplica");
  });

  test("firma falsa → 401; pago pendiente o de otra referencia no registra nada", async () => {
    const { cobro } = await preparar();
    pagosMp["222"] = { id: 222, status: "approved", external_reference: `cobro:${cobro.id}`, transaction_amount: 54000, currency_id: "COP" };
    assert.equal((await webhook("222", { "x-signature": `ts=${Date.now()},v1=abc123`, "x-request-id": "r" })).status, 401);
    assert.equal((await webhook("222", {})).status, 401);
    pagosMp["333"] = { id: 333, status: "pending", external_reference: `cobro:${cobro.id}`, transaction_amount: 54000, currency_id: "COP" };
    assert.equal((await webhook("333", firmar("333"))).status, 200);
    pagosMp["444"] = { id: 444, status: "approved", external_reference: "otra-cosa", transaction_amount: 54000, currency_id: "COP" };
    assert.equal((await webhook("444", firmar("444"))).status, 200);
    assert.equal((await pool.query("SELECT 1 FROM pagos")).rowCount, 0);
  });

  test("contraste de la lectura del comprobante", () => {
    const base = { es_comprobante: true, importe: 54000, fecha: "2026-11-16", referencia: "M123" };
    assert.deepEqual(contrastar(base, { pendiente: 54000, emitido: "2026-10-01", duplicado: false }),
      { importe: "coincide", fecha: "coincide", referencia: "nueva", es_comprobante: true });
    assert.equal(contrastar({ ...base, importe: 50000 }, { pendiente: 54000, emitido: "2026-10-01", duplicado: true }).importe, "distinto");
    assert.equal(contrastar(base, { pendiente: 54000, emitido: "2026-10-01", duplicado: true }).referencia, "ya_usada");
  });
});
