// test/auth.test.js — registro, verificación, login y sesión de punta a punta.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bandejaPruebas, cliente, iniciar, limpiarBD, pool, ultimoCodigo } from "./helpers.js";

let ctx;
before(async () => { ctx = await iniciar(); });
after(async () => { await ctx.cerrar(); });
beforeEach(limpiarBD);

const DATOS = { name: "Ana Pérez", email: "Ana@Ejemplo.com", password: "clave1234" };
const EMAIL = "ana@ejemplo.com";

async function registrarYVerificar(api) {
  await api.post("/auth/registro", DATOS);
  const r = await api.post("/auth/verificar-email", { email: EMAIL, codigo: ultimoCodigo(EMAIL) });
  assert.equal(r.status, 200);
  return r.body.data;
}

describe("registro y verificación", () => {
  test("crea la cuenta sin sesión y envía código", async () => {
    const api = cliente(ctx.base);
    const r = await api.post("/auth/registro", DATOS);
    assert.equal(r.status, 201);
    assert.equal(r.body.data.requiereVerificacion, true);
    assert.equal(r.body.data.email, EMAIL);
    assert.equal(api.cookie, null, "no debe emitir sesión antes de verificar");
    assert.match(ultimoCodigo(EMAIL), /^\d{6}$/);
  });

  test("valida datos y rechaza email duplicado", async () => {
    const api = cliente(ctx.base);
    assert.equal((await api.post("/auth/registro", { ...DATOS, password: "corta" })).status, 400);
    assert.equal((await api.post("/auth/registro", { ...DATOS, password: "sinnumeros" })).status, 400);
    assert.equal((await api.post("/auth/registro", { ...DATOS, email: "malo" })).status, 400);
    await api.post("/auth/registro", DATOS);
    assert.equal((await api.post("/auth/registro", DATOS)).status, 409);
  });

  test("verificar con código correcto emite sesión", async () => {
    const api = cliente(ctx.base);
    const data = await registrarYVerificar(api);
    assert.ok(data.accessToken);
    assert.equal(data.usuario.email_verificado, true);
    assert.ok(api.cookie?.startsWith("refresh_token="));
    const sc = (await api.post("/auth/refresh")).setCookie.join(";");
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Lax/i);
  });

  test("código incorrecto 5 veces invalida el código (sin bloquear la cuenta)", async () => {
    const api = cliente(ctx.base);
    await api.post("/auth/registro", DATOS);
    const bueno = ultimoCodigo(EMAIL);
    const malo = bueno === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i++) {
      assert.equal((await api.post("/auth/verificar-email", { email: EMAIL, codigo: malo })).status, 401);
    }
    assert.equal((await api.post("/auth/verificar-email", { email: EMAIL, codigo: bueno })).status, 401);
    const { rows } = await pool.query("SELECT bloqueado FROM usuarios WHERE email = $1", [EMAIL]);
    assert.equal(rows[0].bloqueado, false);
  });

  test("reenviar respeta cooldown y es genérico para emails inexistentes", async () => {
    const api = cliente(ctx.base);
    assert.equal((await api.post("/auth/verificar-email/reenviar", { email: "nadie@x.com" })).status, 200);
    await api.post("/auth/registro", DATOS);
    const r = await api.post("/auth/verificar-email/reenviar", { email: EMAIL });
    assert.equal(r.status, 429);
    assert.ok(r.body.data.reintentarEn > 0);
  });

  test("el código se guarda hasheado", async () => {
    const api = cliente(ctx.base);
    await api.post("/auth/registro", DATOS);
    const { rows } = await pool.query("SELECT codigo_hash FROM auth_codigos");
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].codigo_hash, ultimoCodigo(EMAIL));
    assert.equal(rows[0].codigo_hash.length, 64);
  });
});

describe("login", () => {
  test("login correcto emite sesión; email insensible a mayúsculas", async () => {
    const api = cliente(ctx.base);
    await registrarYVerificar(api);
    const r = await cliente(ctx.base).post("/auth/login", { email: "ANA@ejemplo.COM", password: DATOS.password });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.accessToken);
  });

  test("credenciales incorrectas no revelan si el email existe", async () => {
    const api = cliente(ctx.base);
    await registrarYVerificar(api);
    const a = await api.post("/auth/login", { email: EMAIL, password: "otra1234" });
    const b = await api.post("/auth/login", { email: "nadie@x.com", password: "otra1234" });
    assert.equal(a.status, 401);
    assert.deepEqual(a.body, b.body);
  });

  test("sin verificar: pide verificación y no da sesión", async () => {
    const api = cliente(ctx.base);
    await api.post("/auth/registro", DATOS);
    const r = await api.post("/auth/login", { email: EMAIL, password: DATOS.password });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.requiereVerificacion, true);
    assert.equal(r.body.data.accessToken, undefined);
  });

  test("con otp_activo: pide OTP, envía código y no da sesión", async () => {
    const api = cliente(ctx.base);
    await registrarYVerificar(api);
    await pool.query("UPDATE usuarios SET otp_activo = true");
    const antes = bandejaPruebas.length;
    const r = await cliente(ctx.base).post("/auth/login", { email: EMAIL, password: DATOS.password });
    assert.equal(r.body.data.requiereOTP, true);
    assert.equal(r.body.data.accessToken, undefined);
    assert.equal(bandejaPruebas.length, antes + 1);
    assert.match(bandejaPruebas.at(-1).subject, /inicio de sesión/);
  });

  test("5 contraseñas erróneas bloquean, avisan por email y revocan sesiones", async () => {
    const api = cliente(ctx.base);
    await registrarYVerificar(api);
    await pool.query("DELETE FROM rate_limits");
    for (let i = 0; i < 5; i++) await cliente(ctx.base).post("/auth/login", { email: EMAIL, password: "mala1234" });
    await new Promise((r) => setTimeout(r, 50)); // email de bloqueo es async
    assert.match(bandejaPruebas.at(-1).subject, /Bloqueamos/);
    await pool.query("DELETE FROM rate_limits");
    const r = await cliente(ctx.base).post("/auth/login", { email: EMAIL, password: DATOS.password });
    assert.equal(r.status, 403);
    assert.equal(r.body.data.codigo, "cuenta_bloqueada");
    assert.equal((await api.post("/auth/refresh")).status, 401, "la sesión previa queda revocada");
  });

  test("rate limit por email corta en el 6º intento", async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await cliente(ctx.base).post("/auth/login", { email: "x@x.com", password: "a1234567" })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  });
});

describe("sesión", () => {
  test("me con access token; sin token 401", async () => {
    const api = cliente(ctx.base);
    const { accessToken } = await registrarYVerificar(api);
    const r = await api.get("/auth/me", { token: accessToken });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.email, EMAIL);
    assert.equal(r.body.data.password, undefined);
    assert.equal((await api.get("/auth/me")).status, 401);
    assert.equal((await api.get("/auth/me", { token: "basura" })).status, 401);
  });

  test("refresh rota el token; reutilizar uno viejo (fuera de gracia) revoca todo", async () => {
    const api = cliente(ctx.base);
    await registrarYVerificar(api);
    const viejo = api.cookie;
    const r1 = await api.post("/auth/refresh");
    assert.equal(r1.status, 200);
    assert.ok(r1.body.data.accessToken);
    assert.notEqual(api.cookie, viejo);
    const actual = api.cookie;

    // Simula que el token viejo se revocó hace más de 30 s y alguien lo reutiliza.
    await pool.query("UPDATE refresh_tokens SET revocado_en = now() - interval '1 minute' WHERE revocado");
    const atacante = cliente(ctx.base);
    atacante.cookie = viejo;
    assert.equal((await atacante.post("/auth/refresh")).status, 401);

    api.cookie = actual;
    assert.equal((await api.post("/auth/refresh")).status, 401, "la cadena legítima también se revoca");
  });

  test("refresh concurrente dentro de la gracia no cierra la sesión", async () => {
    const api = cliente(ctx.base);
    await registrarYVerificar(api);
    const mismo = api.cookie;
    const a = cliente(ctx.base); a.cookie = mismo;
    const b = cliente(ctx.base); b.cookie = mismo;
    const [ra, rb] = await Promise.all([a.post("/auth/refresh"), b.post("/auth/refresh")]);
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    assert.equal((await a.post("/auth/refresh")).status, 200);
  });

  test("logout revoca el refresh; logout-todo cierra todas", async () => {
    const api = cliente(ctx.base);
    const { accessToken } = await registrarYVerificar(api);
    const otro = cliente(ctx.base);
    await otro.post("/auth/login", { email: EMAIL, password: DATOS.password });

    const guardada = api.cookie;
    assert.equal((await api.post("/auth/logout")).status, 200);
    assert.equal(api.cookie, null);
    api.cookie = guardada;
    assert.equal((await api.post("/auth/refresh")).status, 401);

    assert.equal((await api.post("/auth/logout-todo", null, { token: accessToken })).status, 200);
    assert.equal((await otro.post("/auth/refresh")).status, 401);
  });

  test("refresh sin cookie o con cookie falsa → 401", async () => {
    const api = cliente(ctx.base);
    assert.equal((await api.post("/auth/refresh")).status, 401);
    api.cookie = "refresh_token=falso";
    assert.equal((await api.post("/auth/refresh")).status, 401);
  });
});
