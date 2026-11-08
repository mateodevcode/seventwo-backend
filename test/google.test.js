// test/google.test.js — OAuth de Google con los endpoints de Google simulados
// (se intercepta fetch hacia oauth2.googleapis.com y openidconnect.googleapis.com).
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { cliente, iniciar, limpiarBD, pool, ultimoCodigo } from "./helpers.js";
import { GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, sanearNext } from "../src/controllers/google.controllers.js";

let ctx;
const fetchReal = globalThis.fetch;
let perfilGoogle;
let tokenOk;

before(async () => { ctx = await iniciar(); });
after(async () => { await ctx.cerrar(); });
beforeEach(async () => {
  await limpiarBD();
  tokenOk = true;
  perfilGoogle = { sub: "g-123", email: "Gabi@Gmail.com", email_verified: true, name: "Gabi Gómez", picture: "https://foto/g.png" };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u === GOOGLE_TOKEN_URL) {
      return tokenOk
        ? Response.json({ access_token: "ya29.fake", token_type: "Bearer" })
        : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (u === GOOGLE_USERINFO_URL) return Response.json(perfilGoogle);
    return fetchReal(url, opts);
  };
});
afterEach(() => { globalThis.fetch = fetchReal; });

const EMAIL = "gabi@gmail.com";
const FRONT = "http://localhost:3000";

// Recorre el flujo: /auth/google → (Google) → /auth/google/callback.
async function flujoGoogle(api = cliente(ctx.base), { next = "/area-cliente/seguridad", stateManipulado } = {}) {
  const ini = await api.get(`/auth/google?next=${encodeURIComponent(next)}`);
  assert.equal(ini.status, 302);
  const destino = new URL(ini.location);
  assert.equal(destino.origin + destino.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const state = stateManipulado ?? destino.searchParams.get("state");
  const cb = await api.get(`/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(cb.status, 302);
  return { api, ini, cb, url: new URL(cb.location) };
}

describe("Google OAuth", () => {
  test("inicio: redirige a Google con scope, state y cookie g_state", async () => {
    const api = cliente(ctx.base);
    const r = await api.get("/auth/google?next=/area-cliente");
    const q = new URL(r.location).searchParams;
    assert.equal(q.get("scope"), "openid email profile");
    assert.equal(q.get("response_type"), "code");
    assert.ok(q.get("state"));
    assert.ok(api.jar.get("g_state"));
    assert.match(r.setCookie.join(";"), /g_state=.*HttpOnly/i);
  });

  test("usuario nuevo: crea la cuenta Google verificada y deja sesión por cookie", async () => {
    const { api, url } = await flujoGoogle();
    assert.equal(url.origin, FRONT);
    assert.equal(url.pathname, "/auth/google/callback");
    assert.equal(url.searchParams.get("next"), "/area-cliente/seguridad");
    assert.ok(api.cookie, "cookie refresh emitida");
    assert.ok(!api.jar.has("g_state"), "g_state se borra");

    const { rows: [u] } = await pool.query("SELECT * FROM usuarios WHERE email = $1", [EMAIL]);
    assert.equal(u.provider, "google");
    assert.equal(u.google_id, "g-123");
    assert.equal(u.password, null);
    assert.equal(u.email_verificado, true);
    assert.equal(u.image_url, "https://foto/g.png");

    const r = await api.post("/auth/refresh");
    assert.equal(r.status, 200);
    assert.equal(r.body.data.usuario.email, EMAIL);
  });

  test("segundo ingreso reutiliza la cuenta (por google_id) aunque cambie el email", async () => {
    await flujoGoogle();
    perfilGoogle.email = "nuevo@gmail.com";
    await flujoGoogle();
    const { rows } = await pool.query("SELECT email FROM usuarios");
    assert.deepEqual(rows, [{ email: EMAIL }]);
  });

  test("cuenta local verificada: se vincula y conserva la contraseña", async () => {
    const api = cliente(ctx.base);
    await api.post("/auth/registro", { name: "Gabi", email: EMAIL, password: "clave1234" });
    await api.post("/auth/verificar-email", { email: EMAIL, codigo: ultimoCodigo(EMAIL) });
    await flujoGoogle();
    const { rows: [u] } = await pool.query("SELECT * FROM usuarios");
    assert.equal(u.google_id, "g-123");
    assert.equal(u.provider, "local");
    assert.ok(u.password);
    assert.equal((await cliente(ctx.base).post("/auth/login", { email: EMAIL, password: "clave1234" })).status, 200);
  });

  test("cuenta local SIN verificar (posible pre-registro de un atacante): se descarta su contraseña", async () => {
    const atacante = cliente(ctx.base);
    await atacante.post("/auth/registro", { name: "Malo", email: EMAIL, password: "clave1234" });
    await flujoGoogle();
    const { rows: [u] } = await pool.query("SELECT * FROM usuarios");
    assert.equal(u.password, null);
    assert.equal(u.provider, "google");
    assert.equal(u.email_verificado, true);
    const r = await cliente(ctx.base).post("/auth/login", { email: EMAIL, password: "clave1234" });
    assert.equal(r.status, 401);
  });

  test("con OTP activo: envía código y redirige a /login/otp sin sesión", async () => {
    await flujoGoogle();
    await pool.query("UPDATE usuarios SET otp_activo = true");
    const api = cliente(ctx.base);
    const { url } = await flujoGoogle(api);
    assert.equal(url.pathname, "/login/otp");
    assert.equal(url.searchParams.get("email"), EMAIL);
    assert.equal(api.cookie, null);
    const r = await api.post("/auth/otp/verificar", { email: EMAIL, codigo: ultimoCodigo(EMAIL) });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.accessToken);
  });

  test("errores: state manipulado, sin cookie g_state, cancelado, email no verificado, bloqueada, token inválido", async () => {
    const err = (r) => r.url.searchParams.get("error");

    assert.equal(err(await flujoGoogle(undefined, { stateManipulado: "x.y.z" })), "google_estado_invalido");

    // Callback desde un navegador que no inició el flujo (sin g_state).
    const ini = await cliente(ctx.base).get("/auth/google");
    const state = new URL(ini.location).searchParams.get("state");
    const ajeno = await cliente(ctx.base).get(`/auth/google/callback?code=abc&state=${state}`);
    assert.equal(new URL(ajeno.location).searchParams.get("error"), "google_estado_invalido");

    const cancel = await cliente(ctx.base).get("/auth/google/callback?error=access_denied");
    assert.equal(new URL(cancel.location).searchParams.get("error"), "google_cancelado");

    perfilGoogle.email_verified = false;
    assert.equal(err(await flujoGoogle()), "google_email_no_verificado");
    perfilGoogle.email_verified = true;

    tokenOk = false;
    assert.equal(err(await flujoGoogle()), "google_codigo_invalido");
    tokenOk = true;

    await flujoGoogle();
    await pool.query("UPDATE usuarios SET bloqueado = true");
    const bloq = await flujoGoogle();
    assert.equal(err(bloq), "cuenta_bloqueada");
    assert.equal(bloq.api.cookie, null);
  });

  test("email ya vinculado a otra cuenta de Google → google_cuenta_distinta", async () => {
    await flujoGoogle();
    perfilGoogle.sub = "g-otro";
    const { url } = await flujoGoogle();
    assert.equal(url.searchParams.get("error"), "google_cuenta_distinta");
  });

  test("next solo acepta rutas internas", () => {
    assert.equal(sanearNext("/area-cliente/facturas"), "/area-cliente/facturas");
    assert.equal(sanearNext("//evil.com"), "/area-cliente");
    assert.equal(sanearNext("/\\evil.com"), "/area-cliente");
    assert.equal(sanearNext("https://evil.com"), "/area-cliente");
    assert.equal(sanearNext(undefined), "/area-cliente");
  });
});
