// test/password.test.js — restablecer y cambiar contraseña de punta a punta.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bandejaPruebas, cliente, iniciar, limpiarBD, pool, ultimoCodigo } from "./helpers.js";
import { generarAccessToken } from "../src/services/sesion.service.js";

let ctx;
before(async () => { ctx = await iniciar(); });
after(async () => { await ctx.cerrar(); });
beforeEach(limpiarBD);

const EMAIL = "reset@ejemplo.com";
const PASS = "clave1234";
const NUEVA = "nueva5678";
const esperarAvisos = () => new Promise((r) => setTimeout(r, 30));

async function usuarioVerificado() {
  const api = cliente(ctx.base);
  await api.post("/auth/registro", { name: "Rita", email: EMAIL, password: PASS });
  const r = await api.post("/auth/verificar-email", { email: EMAIL, codigo: ultimoCodigo(EMAIL) });
  return { api, token: r.body.data.accessToken };
}

async function obtenerResetToken(email = EMAIL) {
  const api = cliente(ctx.base);
  await api.post("/auth/password/solicitar", { email });
  const r = await api.post("/auth/password/validar", { email, codigo: ultimoCodigo(email) });
  assert.equal(r.status, 200);
  assert.match(r.body.data.resetToken, /^[a-f0-9]{64}$/);
  return r.body.data.resetToken;
}

describe("restablecer contraseña", () => {
  test("flujo completo: cambia la contraseña, cierra sesiones y avisa", async () => {
    const { api } = await usuarioVerificado();
    const resetToken = await obtenerResetToken();

    const r = await cliente(ctx.base).post("/auth/password/restablecer", { resetToken, password: NUEVA });
    assert.equal(r.status, 200);
    await esperarAvisos();
    assert.match(bandejaPruebas.at(-1).subject, /contraseña de Seventwo cambió/);

    assert.equal((await api.post("/auth/refresh")).status, 401, "la sesión previa se revoca");
    assert.equal((await cliente(ctx.base).post("/auth/login", { email: EMAIL, password: PASS })).status, 401);
    const login = await cliente(ctx.base).post("/auth/login", { email: EMAIL, password: NUEVA });
    assert.ok(login.body.data.accessToken);
  });

  test("solicitar es genérico: misma respuesta exista o no el email, sin email para inexistentes", async () => {
    await usuarioVerificado();
    const antes = bandejaPruebas.length;
    const a = await cliente(ctx.base).post("/auth/password/solicitar", { email: "nadie@x.com" });
    assert.equal(bandejaPruebas.length, antes);
    const b = await cliente(ctx.base).post("/auth/password/solicitar", { email: EMAIL });
    assert.equal(bandejaPruebas.length, antes + 1);
    assert.deepEqual(a.body, b.body);
    // En cooldown tampoco cambia la respuesta (ni se envía otro email).
    const c = await cliente(ctx.base).post("/auth/password/solicitar", { email: EMAIL });
    assert.deepEqual(c.body, b.body);
    assert.equal(bandejaPruebas.length, antes + 1);
  });

  test("el resetToken es de un solo uso", async () => {
    await usuarioVerificado();
    const resetToken = await obtenerResetToken();
    assert.equal((await cliente(ctx.base).post("/auth/password/restablecer", { resetToken, password: NUEVA })).status, 200);
    assert.equal((await cliente(ctx.base).post("/auth/password/restablecer", { resetToken, password: "otra9999" })).status, 401);
  });

  test("contraseña débil no gasta el token; token falso o caducado → 401", async () => {
    await usuarioVerificado();
    const resetToken = await obtenerResetToken();
    assert.equal((await cliente(ctx.base).post("/auth/password/restablecer", { resetToken, password: "corta" })).status, 400);
    assert.equal((await cliente(ctx.base).post("/auth/password/restablecer", { resetToken: "a".repeat(64), password: NUEVA })).status, 401);
    await pool.query("UPDATE auth_codigos SET expira_en = now() - interval '1 second' WHERE tipo = 'reset_token'");
    assert.equal((await cliente(ctx.base).post("/auth/password/restablecer", { resetToken, password: NUEVA })).status, 401);
  });

  test("código de reset erróneo 5 veces lo invalida sin bloquear la cuenta", async () => {
    await usuarioVerificado();
    const api = cliente(ctx.base);
    await api.post("/auth/password/solicitar", { email: EMAIL });
    const codigo = ultimoCodigo(EMAIL);
    const malo = codigo === "123456" ? "654321" : "123456";
    for (let i = 0; i < 4; i++) await api.post("/auth/password/validar", { email: EMAIL, codigo: malo });
    await pool.query("DELETE FROM rate_limits");
    await api.post("/auth/password/validar", { email: EMAIL, codigo: malo });
    assert.equal((await api.post("/auth/password/validar", { email: EMAIL, codigo })).status, 401);
    const { rows } = await pool.query("SELECT bloqueado FROM usuarios");
    assert.equal(rows[0].bloqueado, false);
  });

  test("desbloquea una cuenta bloqueada por intentos fallidos", async () => {
    await usuarioVerificado();
    await pool.query("UPDATE usuarios SET bloqueado = true, intentos_fallidos = 5");
    const resetToken = await obtenerResetToken();
    await cliente(ctx.base).post("/auth/password/restablecer", { resetToken, password: NUEVA });
    const { rows } = await pool.query("SELECT bloqueado, intentos_fallidos FROM usuarios");
    assert.deepEqual(rows[0], { bloqueado: false, intentos_fallidos: 0 });
    assert.equal((await cliente(ctx.base).post("/auth/login", { email: EMAIL, password: NUEVA })).status, 200);
  });

  test("cuenta solo-Google puede crearse una contraseña", async () => {
    await pool.query(
      `INSERT INTO usuarios (name, email, provider, email_verificado) VALUES ('Gus', 'gus@ejemplo.com', 'google', true)`,
    );
    const resetToken = await obtenerResetToken("gus@ejemplo.com");
    await cliente(ctx.base).post("/auth/password/restablecer", { resetToken, password: NUEVA });
    const login = await cliente(ctx.base).post("/auth/login", { email: "gus@ejemplo.com", password: NUEVA });
    assert.ok(login.body.data.accessToken);
  });
});

describe("cambiar contraseña (con sesión)", () => {
  test("cambia, cierra las demás sesiones y deja una nueva para este dispositivo", async () => {
    const { api, token } = await usuarioVerificado();
    const otro = cliente(ctx.base);
    await otro.post("/auth/login", { email: EMAIL, password: PASS });

    const r = await api.patch("/auth/password", { actual: PASS, nueva: NUEVA }, { token });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.accessToken);
    assert.equal((await otro.post("/auth/refresh")).status, 401, "otra sesión revocada");
    assert.equal((await api.post("/auth/refresh")).status, 200, "la sesión nueva funciona");
    assert.equal((await cliente(ctx.base).post("/auth/login", { email: EMAIL, password: NUEVA })).status, 200);
  });

  test("valida contraseña actual, fortaleza y que sea distinta", async () => {
    const { api, token } = await usuarioVerificado();
    assert.equal((await api.patch("/auth/password", { actual: "mala1234", nueva: NUEVA }, { token })).status, 401);
    assert.equal((await api.patch("/auth/password", { actual: PASS, nueva: "corta" }, { token })).status, 400);
    assert.equal((await api.patch("/auth/password", { actual: PASS, nueva: PASS }, { token })).status, 400);
    assert.equal((await api.patch("/auth/password", { actual: PASS, nueva: NUEVA })).status, 401, "sin token");
  });

  test("cuenta solo-Google → 400 indicando usar el flujo de reset", async () => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (name, email, provider, email_verificado) VALUES ('Gus', 'gus@ejemplo.com', 'google', true) RETURNING *`,
    );
    const r = await cliente(ctx.base).patch("/auth/password", { actual: "x", nueva: NUEVA }, { token: generarAccessToken(u) });
    assert.equal(r.status, 400);
  });
});
