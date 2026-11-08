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

// Cliente con cookie jar mínimo (sin dominios ni paths: un solo backend).
// `cookie` expone/fija directamente el par "refresh_token=…".
export function cliente(base) {
  const jar = new Map();
  const llamar = async (metodo, ruta, { body, token, sinCookie } = {}) => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (jar.size && !sinCookie) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(base + ruta, {
      method: metodo,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const [par] = c.split(";");
      const i = par.indexOf("=");
      const [k, v] = [par.slice(0, i), par.slice(i + 1)];
      if (!v || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k);
      else jar.set(k, v);
    }
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* redirección u otro */ }
    return { status: res.status, body: json, setCookie, location: res.headers.get("location") };
  };
  return {
    post: (ruta, body, opts) => llamar("POST", ruta, { ...opts, body }),
    patch: (ruta, body, opts) => llamar("PATCH", ruta, { ...opts, body }),
    get: (ruta, opts) => llamar("GET", ruta, opts),
    del: (ruta, opts) => llamar("DELETE", ruta, opts),
    jar,
    get cookie() { return jar.has("refresh_token") ? `refresh_token=${jar.get("refresh_token")}` : null; },
    set cookie(v) {
      if (!v) jar.delete("refresh_token");
      else jar.set("refresh_token", v.replace(/^refresh_token=/, ""));
    },
  };
}
