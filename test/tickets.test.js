// test/tickets.test.js — F5: tickets de soporte (cliente ↔ equipo, notas internas, estados, aislamiento).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bandejaPruebas, cliente, iniciar, limpiarBD, pool, ultimoCodigo } from "./helpers.js";

let ctx;
before(async () => { ctx = await iniciar(); });
after(async () => { await ctx.cerrar(); });
beforeEach(limpiarBD);

const PASS = "clave1234";
const esperar = (ms = 100) => new Promise((r) => setTimeout(r, ms));

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

async function preparar() {
  const adm = await cuenta("adm", "admin");
  const ceci = await cuenta("ceci");
  const { body: { data: c } } = await adm.api.post("/admin/clientes", { email: ceci.email, nombre: "Doña Ceci" }, { token: adm.token });
  const { body: { data: p } } = await adm.api.post("/admin/proyectos", { cliente_id: c.id, nombre: "Carta digital", estado: "mantenimiento", avisar: false }, { token: adm.token });
  bandejaPruebas.length = 0;
  return { adm, ceci, p };
}

describe("tickets", () => {
  test("conversación completa: abrir, responder, nota interna invisible, resolver y reabrir", async () => {
    const { adm, ceci, p } = await preparar();
    const nuevo = await ceci.api.post("/tickets/mios", {
      asunto: "Cambiar precio de un plato", categoria: "cambio", prioridad: "alta", proyecto: p.codigo,
      cuerpo: "Necesito subir el precio del ceviche a $32.000.",
    }, { token: ceci.token });
    assert.equal(nuevo.status, 201, JSON.stringify(nuevo.body));
    const codigo = nuevo.body.data.codigo;
    assert.match(codigo, /^T-\d{4,}$/);
    await esperar();
    assert.ok(bandejaPruebas.some((m) => m.to === "info@seventwo.tech" && /Nuevo ticket/.test(m.subject)));

    const lista = await adm.api.get("/admin/tickets", { token: adm.token });
    const t = lista.body.data.tickets[0];
    assert.equal(t.proyecto_codigo, p.codigo);
    const ver = await adm.api.get(`/admin/tickets/${t.id}`, { token: adm.token });
    assert.equal(ver.body.data.asignado, "adm Pérez", "se asigna a quien lo abre");

    await adm.api.post(`/admin/tickets/${t.id}/mensajes`, { cuerpo: "Revisar si tiene más platos", interno: true }, { token: adm.token });
    bandejaPruebas.length = 0;
    const r = await adm.api.post(`/admin/tickets/${t.id}/mensajes`, { cuerpo: "Listo, ya está actualizado." }, { token: adm.token });
    assert.equal(r.body.data.estado, "esperando_cliente");
    await esperar();
    assert.ok(bandejaPruebas.some((m) => m.to === ceci.email && /respondió/.test(m.subject)));

    const mio = await ceci.api.get(`/tickets/mios/${codigo}`, { token: ceci.token });
    assert.equal(mio.body.data.mensajes.length, 2, "no ve la nota interna");
    assert.equal(mio.body.data.asignado_a, undefined);

    await adm.api.patch(`/admin/tickets/${t.id}`, { estado: "resuelto" }, { token: adm.token });
    await ceci.api.post(`/tickets/mios/${codigo}/mensajes`, { cuerpo: "Falta el de la limonada" }, { token: ceci.token });
    const { rows: [x] } = await pool.query("SELECT estado FROM tickets WHERE id = $1", [t.id]);
    assert.equal(x.estado, "abierto", "una respuesta del cliente lo reabre");

    await adm.api.patch(`/admin/tickets/${t.id}`, { estado: "cerrado" }, { token: adm.token });
    assert.equal((await ceci.api.post(`/tickets/mios/${codigo}/mensajes`, { cuerpo: "Hola?" }, { token: ceci.token })).status, 409);
  });

  test("validación y aislamiento", async () => {
    const { adm, ceci, p } = await preparar();
    assert.equal((await ceci.api.post("/tickets/mios", { asunto: "Hola", cuerpo: "corto" }, { token: ceci.token })).status, 400);
    const otro = await cuenta("otro");
    await adm.api.post("/admin/clientes", { email: otro.email, nombre: "Otro" }, { token: adm.token });
    await pool.query("DELETE FROM rate_limits");
    assert.equal((await otro.api.post("/tickets/mios", { asunto: "Proyecto ajeno", cuerpo: "Quiero ver este proyecto", proyecto: p.codigo }, { token: otro.token })).status, 400);
    const { body: { data: { codigo } } } = await ceci.api.post("/tickets/mios", { asunto: "Duda general", cuerpo: "¿Cuándo es la próxima actualización?" }, { token: ceci.token });
    assert.equal((await otro.api.get(`/tickets/mios/${codigo}`, { token: otro.token })).status, 404);
    assert.equal((await otro.api.get("/admin/tickets", { token: otro.token })).status, 403);
    const sinFicha = await cuenta("libre");
    assert.equal((await sinFicha.api.post("/tickets/mios", { asunto: "Hola equipo", cuerpo: "No soy cliente todavía" }, { token: sinFicha.token })).status, 404);
  });
});
