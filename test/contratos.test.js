// test/contratos.test.js — F2 de docs/CLIENTES.md: subir (borrador o firmado fuera),
// enviar, aceptar con evidencia, versiones, permisos y verificación de la huella.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bandejaPruebas, cliente, iniciar, limpiarBD, pool, ultimoCodigo } from "./helpers.js";
import { memoriaPruebas } from "../src/lib/almacen.js";

let ctx;
before(async () => { ctx = await iniciar(); });
after(async () => { await ctx.cerrar(); });
beforeEach(async () => {
  await limpiarBD();
  memoriaPruebas.clear();
});

const PASS = "clave1234";
const esperar = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");

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

/** Sube un PDF crudo como lo hace el panel. */
async function subir(token, proyectoId, { body = PDF, tipo = "application/pdf", titulo = "Contrato de desarrollo web", fuera = false } = {}) {
  const qs = new URLSearchParams({ titulo, nombre: "Contrato Laura.pdf", ...(fuera ? { firmado_fuera: "1" } : {}) });
  const res = await fetch(`${ctx.base}/admin/proyectos/${proyectoId}/contratos?${qs}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": tipo },
    body,
  });
  return { status: res.status, body: await res.json() };
}

async function preparar() {
  const adm = await cuenta("adm", "admin");
  const laura = await cuenta("laura");
  const { body: { data: c } } = await adm.api.post("/admin/clientes", { email: laura.email, nombre: "Laura Gómez" }, { token: adm.token });
  const { body: { data: p } } = await adm.api.post("/admin/proyectos", { cliente_id: c.id, nombre: "Web Laura", estado: "en_curso" }, { token: adm.token });
  return { adm, laura, c, p };
}

describe("contratos", () => {
  test("borrador invisible para el cliente → enviar → aceptar con evidencia y avisos", async () => {
    const { adm, laura, p } = await preparar();
    const s = await subir(adm.token, p.id);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(s.body.data.estado, "borrador");
    const id = s.body.data.id;

    const { rows: [a] } = await pool.query("SELECT * FROM archivos");
    assert.match(a.s3_clave, /^seventwo\/privado\/contratos\/\d+\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/, "clave privada, sin datos personales");
    assert.ok(memoriaPruebas.has(a.s3_clave));

    let det = await laura.api.get(`/proyectos/mios/${p.codigo}`, { token: laura.token });
    assert.deepEqual(det.body.data.contratos, [], "el borrador no se ve");
    assert.equal((await laura.api.get(`/contratos/${id}/archivo`, { token: laura.token })).status, 404);

    bandejaPruebas.length = 0;
    const env = await adm.api.post(`/admin/contratos/${id}/enviar`, { nota: "Revisa la cláusula 4." }, { token: adm.token });
    assert.equal(env.status, 200, JSON.stringify(env.body));
    await esperar();
    const mail = bandejaPruebas.find((m) => m.to === laura.email);
    assert.match(mail.subject, /Contrato de P-\d+ listo para revisar/);
    assert.match(mail.html, /cláusula 4/);

    det = await laura.api.get(`/proyectos/mios/${p.codigo}`, { token: laura.token });
    assert.equal(det.body.data.contratos[0].estado, "enviado");
    assert.equal(det.body.data.contratos[0].aceptado_ip, undefined, "el cliente no ve campos internos");
    const url = await laura.api.get(`/contratos/${id}/archivo`, { token: laura.token });
    assert.match(url.body.data.url, /^memoria:\/\/seventwo\/privado\//);

    const resumen = await laura.api.get("/clientes/yo/resumen", { token: laura.token });
    assert.equal(resumen.body.data.contratos_pendientes.length, 1);

    // Validación: nombre y casilla obligatorios.
    assert.equal((await laura.api.post(`/contratos/${id}/aceptar`, { nombre: "Laura Gómez" }, { token: laura.token })).status, 400);
    assert.equal((await laura.api.post(`/contratos/${id}/aceptar`, { nombre: "La", acepto: true }, { token: laura.token })).status, 400);

    bandejaPruebas.length = 0;
    const ok = await laura.api.post(`/contratos/${id}/aceptar`, { nombre: "Laura Gómez Ruiz", acepto: true }, { token: laura.token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await esperar();
    const { rows: [k] } = await pool.query("SELECT * FROM contratos WHERE id = $1", [id]);
    assert.equal(k.estado, "aceptado");
    assert.equal(k.aceptado_nombre, "Laura Gómez Ruiz");
    assert.equal(k.aceptado_por, laura.id);
    assert.ok(k.aceptado_ip && k.aceptado_en);
    assert.equal(k.sha256, a.sha256);
    assert.ok(bandejaPruebas.some((m) => m.to === "info@seventwo.tech" && /aceptó el contrato/.test(m.subject)));
    const { rows: notifs } = await pool.query("SELECT tipo FROM notificaciones WHERE usuario_id = $1", [adm.id]);
    assert.ok(notifs.some((n) => n.tipo === "contrato_aceptado"));

    assert.equal((await laura.api.post(`/contratos/${id}/aceptar`, { nombre: "Laura Gómez Ruiz", acepto: true }, { token: laura.token })).status, 409);
  });

  test("nueva versión reemplaza a la vigente; los borradores se pueden borrar, los enviados no", async () => {
    const { adm, laura, p } = await preparar();
    const v1 = (await subir(adm.token, p.id)).body.data.id;
    await adm.api.post(`/admin/contratos/${v1}/enviar`, {}, { token: adm.token });
    const v2 = (await subir(adm.token, p.id, { titulo: "Contrato corregido" })).body.data.id;
    assert.equal((await adm.api.del(`/admin/contratos/${v1}`, { token: adm.token })).status, 409);
    await adm.api.post(`/admin/contratos/${v2}/enviar`, {}, { token: adm.token });

    const det = await laura.api.get(`/proyectos/mios/${p.codigo}`, { token: laura.token });
    assert.deepEqual(det.body.data.contratos.map((c) => [c.version, c.estado]), [[2, "enviado"], [1, "reemplazado"]]);
    assert.equal((await laura.api.post(`/contratos/${v1}/aceptar`, { nombre: "Laura Gómez", acepto: true }, { token: laura.token })).status, 409);

    const v3 = (await subir(adm.token, p.id, { titulo: "Borrador que sobra" })).body.data.id;
    assert.equal(memoriaPruebas.size, 3);
    assert.equal((await adm.api.del(`/admin/contratos/${v3}`, { token: adm.token })).status, 200);
    assert.equal(memoriaPruebas.size, 2, "borra también el objeto en S3");
  });

  test("firmado fuera: queda vigente al momento y reemplaza al enviado", async () => {
    const { adm, laura, p } = await preparar();
    const v1 = (await subir(adm.token, p.id)).body.data.id;
    await adm.api.post(`/admin/contratos/${v1}/enviar`, {}, { token: adm.token });
    const f = await subir(adm.token, p.id, { titulo: "Contrato firmado en papel", fuera: true });
    assert.equal(f.body.data.estado, "firmado_fuera");
    const det = await laura.api.get(`/proyectos/mios/${p.codigo}`, { token: laura.token });
    assert.deepEqual(det.body.data.contratos.map((c) => c.estado), ["firmado_fuera", "reemplazado"]);
  });

  test("solo PDF de verdad; otro cliente no ve nada; un cliente no sube", async () => {
    const { adm, laura, p } = await preparar();
    assert.equal((await subir(adm.token, p.id, { body: Buffer.from("hola, no soy un pdf") })).status, 400);
    assert.equal((await subir(adm.token, p.id, { tipo: "image/png" })).status, 400);
    assert.equal((await subir(adm.token, p.id, { titulo: "" })).status, 400);
    assert.equal((await subir(laura.token, p.id)).status, 403);

    const id = (await subir(adm.token, p.id)).body.data.id;
    await adm.api.post(`/admin/contratos/${id}/enviar`, {}, { token: adm.token });
    const otro = await cuenta("otro");
    await adm.api.post("/admin/clientes", { email: otro.email, nombre: "Otro" }, { token: adm.token });
    await pool.query("DELETE FROM rate_limits");
    assert.equal((await otro.api.get(`/contratos/${id}/archivo`, { token: otro.token })).status, 404);
    assert.equal((await otro.api.post(`/contratos/${id}/aceptar`, { nombre: "Otro Pérez", acepto: true }, { token: otro.token })).status, 404);
    assert.equal((await otro.api.get(`/admin/contratos/${id}/archivo`, { token: otro.token })).status, 403);
  });

  test("si el archivo guardado cambió, no se puede aceptar", async () => {
    const { adm, laura, p } = await preparar();
    const id = (await subir(adm.token, p.id)).body.data.id;
    await adm.api.post(`/admin/contratos/${id}/enviar`, {}, { token: adm.token });
    const [clave] = memoriaPruebas.keys();
    memoriaPruebas.get(clave).body = Buffer.from("%PDF-1.7 manipulado");
    const r = await laura.api.post(`/contratos/${id}/aceptar`, { nombre: "Laura Gómez", acepto: true }, { token: laura.token });
    assert.equal(r.status, 409);
    const { rows: [k] } = await pool.query("SELECT estado FROM contratos WHERE id = $1", [id]);
    assert.equal(k.estado, "enviado");
  });
});
