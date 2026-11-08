// test/otp.test.js — segundo factor por email de punta a punta.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bandejaPruebas, cliente, iniciar, limpiarBD, pool, ultimoCodigo } from "./helpers.js";
import { generarAccessToken } from "../src/services/sesion.service.js";

let ctx;
before(async () => { ctx = await iniciar(); });
after(async () => { await ctx.cerrar(); });
beforeEach(limpiarBD);

const EMAIL = "otp@ejemplo.com";
const PASS = "clave1234";

async function usuarioVerificado() {
  const api = cliente(ctx.base);
  await api.post("/auth/registro", { name: "Oto", email: EMAIL, password: PASS });
  const r = await api.post("/auth/verificar-email", { email: EMAIL, codigo: ultimoCodigo(EMAIL) });
  return { api, token: r.body.data.accessToken };
}

async function activar(api, token) {
  const r1 = await api.post("/auth/otp/activar", null, { token });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.requiereCodigo, true);
  const r2 = await api.post("/auth/otp/activar/confirmar", { codigo: ultimoCodigo(EMAIL) }, { token });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.data.otp_activo, true);
}

const otroCodigo = (c) => (c === "123456" ? "654321" : "123456");
const esperarAvisos = () => new Promise((r) => setTimeout(r, 30));

describe("activar OTP", () => {
  test("activar → confirmar con código → otp_activo y email de aviso", async () => {
    const { api, token } = await usuarioVerificado();
    await activar(api, token);
    await esperarAvisos();
    assert.match(bandejaPruebas.at(-1).subject, /Activaste/);
    const me = await api.get("/auth/me", { token });
    assert.equal(me.body.data.otp_activo, true);
  });

  test("requiere sesión; código erróneo no activa; ya activa → 400", async () => {
    const { api, token } = await usuarioVerificado();
    assert.equal((await api.post("/auth/otp/activar")).status, 401);
    await api.post("/auth/otp/activar", null, { token });
    const malo = otroCodigo(ultimoCodigo(EMAIL));
    assert.equal((await api.post("/auth/otp/activar/confirmar", { codigo: malo }, { token })).status, 401);
    const { rows } = await pool.query("SELECT otp_activo FROM usuarios");
    assert.equal(rows[0].otp_activo, false);
    await pool.query("UPDATE usuarios SET otp_activo = true");
    assert.equal((await api.post("/auth/otp/activar", null, { token })).status, 400);
  });
});

describe("login con OTP", () => {
  test("login → requiereOTP → código correcto da sesión; el código no se reutiliza", async () => {
    const { api, token } = await usuarioVerificado();
    await activar(api, token);

    const nuevo = cliente(ctx.base);
    const r1 = await nuevo.post("/auth/login", { email: EMAIL, password: PASS });
    assert.equal(r1.body.data.requiereOTP, true);
    assert.equal(nuevo.cookie, null);

    const codigo = ultimoCodigo(EMAIL);
    assert.equal((await nuevo.post("/auth/otp/verificar", { email: EMAIL, codigo: otroCodigo(codigo) })).status, 401);
    const r2 = await nuevo.post("/auth/otp/verificar", { email: EMAIL, codigo });
    assert.equal(r2.status, 200);
    assert.ok(r2.body.data.accessToken);
    assert.ok(nuevo.cookie);
    assert.equal((await cliente(ctx.base).post("/auth/otp/verificar", { email: EMAIL, codigo })).status, 401);
  });

  test("sin OTP activo, /otp/verificar no sirve para entrar", async () => {
    await usuarioVerificado();
    const r = await cliente(ctx.base).post("/auth/otp/verificar", { email: EMAIL, codigo: "123456" });
    assert.equal(r.status, 401);
  });

  test("5 códigos erróneos invalidan el código; la cuenta no se bloquea", async () => {
    const { api, token } = await usuarioVerificado();
    await activar(api, token);
    const nuevo = cliente(ctx.base);
    await nuevo.post("/auth/login", { email: EMAIL, password: PASS });
    const codigo = ultimoCodigo(EMAIL);
    for (let i = 0; i < 5; i++) await nuevo.post("/auth/otp/verificar", { email: EMAIL, codigo: otroCodigo(codigo) });
    assert.equal((await nuevo.post("/auth/otp/verificar", { email: EMAIL, codigo })).status, 401);
    const { rows } = await pool.query("SELECT bloqueado FROM usuarios");
    assert.equal(rows[0].bloqueado, false);
  });

  test("reenviar solo actúa con un login pendiente y respeta el cooldown", async () => {
    const { api, token } = await usuarioVerificado();
    await activar(api, token);
    await esperarAvisos();

    // Sin login pendiente: respuesta genérica y ningún email.
    const antes = bandejaPruebas.length;
    assert.equal((await cliente(ctx.base).post("/auth/otp/reenviar", { email: EMAIL })).status, 200);
    assert.equal(bandejaPruebas.length, antes);

    const nuevo = cliente(ctx.base);
    await nuevo.post("/auth/login", { email: EMAIL, password: PASS });
    const primero = ultimoCodigo(EMAIL);
    assert.equal((await nuevo.post("/auth/otp/reenviar", { email: EMAIL })).status, 429);

    await pool.query("UPDATE auth_codigos SET created_at = now() - interval '2 minutes' WHERE tipo = 'otp_login'");
    assert.equal((await nuevo.post("/auth/otp/reenviar", { email: EMAIL })).status, 200);
    const segundo = ultimoCodigo(EMAIL);
    if (segundo !== primero) {
      assert.equal((await nuevo.post("/auth/otp/verificar", { email: EMAIL, codigo: primero })).status, 401);
    }
    assert.equal((await nuevo.post("/auth/otp/verificar", { email: EMAIL, codigo: segundo })).status, 200);
  });
});

describe("desactivar OTP", () => {
  test("con contraseña: incorrecta 401, correcta desactiva y avisa; luego login directo", async () => {
    const { api, token } = await usuarioVerificado();
    await activar(api, token);
    assert.equal((await api.post("/auth/otp/desactivar", { password: "mala1234" }, { token })).status, 401);
    const r = await api.post("/auth/otp/desactivar", { password: PASS }, { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.otp_activo, false);
    await esperarAvisos();
    assert.match(bandejaPruebas.at(-1).subject, /Desactivaste/);
    const login = await cliente(ctx.base).post("/auth/login", { email: EMAIL, password: PASS });
    assert.ok(login.body.data.accessToken);
  });

  test("cuenta solo-Google: desactiva con código por email", async () => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (name, email, provider, email_verificado, otp_activo)
       VALUES ('Gina', 'gina@ejemplo.com', 'google', true, true) RETURNING *`,
    );
    const token = generarAccessToken(u);
    const api = cliente(ctx.base);
    const r1 = await api.post("/auth/otp/desactivar", {}, { token });
    assert.equal(r1.body.data.requiereCodigo, true);
    const r2 = await api.post("/auth/otp/desactivar/confirmar", { codigo: ultimoCodigo("gina@ejemplo.com") }, { token });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.data.otp_activo, false);
  });

  test("desactivar sin OTP activo → 400", async () => {
    const { api, token } = await usuarioVerificado();
    assert.equal((await api.post("/auth/otp/desactivar", { password: PASS }, { token })).status, 400);
  });
});
