// test/helpers.js — arranca la app en un puerto libre contra la BD de pruebas
// y ofrece un cliente HTTP con "cookie jar" mínimo.
import { crearApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { migrar } from "../src/database/migrate.js";
import { bandejaPruebas } from "../src/lib/mailer.js";

export { pool, bandejaPruebas };

export async function iniciar() {
  if (!/_test\b/.test(process.env.DATABASE_URL || "")) {
    throw new Error("Los tests requieren una BD cuyo nombre termine en _test (borran datos).");
  }
  await migrar({ log: () => {} });
  const server = crearApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    cerrar: async () => {
      await new Promise((r) => server.close(r));
      await pool.end();
    },
  };
}

export async function limpiarBD() {
  await pool.query("TRUNCATE usuarios, refresh_tokens, auth_codigos, rate_limits RESTART IDENTITY CASCADE");
  bandejaPruebas.length = 0;
}

// Último código de 6 dígitos enviado a `email`.
export function ultimoCodigo(email) {
  const msg = [...bandejaPruebas].reverse().find((m) => m.to === email);
  return msg?.text?.match(/\b(\d{6})\b/)?.[1] ?? null;
}

// Cliente con cookies (solo refresh_token nos interesa).
export function cliente(base) {
  let cookie = null;
  const llamar = async (metodo, ruta, { body, token, sinCookie } = {}) => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie && !sinCookie) headers.Cookie = cookie;
    const res = await fetch(base + ruta, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const [par] = c.split(";");
      if (par.startsWith("refresh_token=")) cookie = par.endsWith("=") ? null : par;
    }
    return { status: res.status, body: await res.json(), setCookie };
  };
  return {
    post: (ruta, body, opts) => llamar("POST", ruta, { ...opts, body }),
    get: (ruta, opts) => llamar("GET", ruta, opts),
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
}
