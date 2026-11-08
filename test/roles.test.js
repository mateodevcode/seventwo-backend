// test/roles.test.js — roles (usuario < cliente < admin < superadmin), API /admin,
// perfil propio y script de roles.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliente, iniciar, limpiarBD, pool, ultimoCodigo } from "./helpers.js";

let ctx;
before(async () => { ctx = await iniciar(); });
after(async () => { await ctx.cerrar(); });
beforeEach(limpiarBD);

const PASS = "clave1234";

// Crea una cuenta verificada con el rol dado y devuelve su sesión (cookie + token).
async function cuenta(nombre, rol = "usuario") {
  const email = `${nombre}@ejemplo.com`;
  const api = cliente(ctx.base);
  await api.post("/auth/registro", { name: nombre, email, password: PASS });
  await api.post("/auth/verificar-email", { email, codigo: ultimoCodigo(email) });
  const { rows: [u] } = await pool.query("UPDATE usuarios SET rol = $2 WHERE email = $1 RETURNING id", [email, rol]);
  await pool.query("DELETE FROM rate_limits");
  const r = await api.post("/auth/login", { email, password: PASS });
  return { api, id: u.id, email, token: r.body.data.accessToken };
}

describe("rol por defecto", () => {
  test("registrarse crea la cuenta como 'usuario'", async () => {
    const api = cliente(ctx.base);
    await api.post("/auth/registro", { name: "Nuevo", email: "nuevo@ejemplo.com", password: PASS });
    const r = await api.post("/auth/verificar-email", { email: "nuevo@ejemplo.com", codigo: ultimoCodigo("nuevo@ejemplo.com") });
    assert.equal(r.body.data.usuario.rol, "usuario");
  });

  test("el CHECK de la BD solo admite los cuatro roles", async () => {
    await assert.rejects(
      pool.query("INSERT INTO usuarios (name, email, rol) VALUES ('X', 'x@x.com', 'jefe')"),
      /usuarios_rol_check/,
    );
  });
});

describe("acceso al panel /admin", () => {
  test("usuario y cliente reciben 403; sin token 401; admin y superadmin entran", async () => {
    const u = await cuenta("usu", "usuario");
    const c = await cuenta("cli", "cliente");
    const a = await cuenta("adm", "admin");
    const s = await cuenta("sup", "superadmin");
    assert.equal((await u.api.get("/admin/usuarios", { token: u.token })).status, 403);
    assert.equal((await c.api.get("/admin/usuarios", { token: c.token })).status, 403);
    assert.equal((await u.api.get("/admin/usuarios")).status, 401);
    const ra = await a.api.get("/admin/usuarios", { token: a.token });
    assert.equal(ra.status, 200);
    assert.equal(ra.body.data.total, 4);
    assert.equal(ra.body.data.usuarios[0].rol, "superadmin", "orden: superadmin primero");
    assert.equal(ra.body.data.usuarios[0].password, undefined, "nunca expone el hash");
    assert.equal((await s.api.get("/admin/resumen", { token: s.token })).body.data.equipo, 2);
  });

  test("el rol se lee de la BD: un admin degradado pierde acceso aunque su token diga admin", async () => {
    const a = await cuenta("adm", "admin");
    await pool.query("UPDATE usuarios SET rol = 'usuario' WHERE id = $1", [a.id]);
    assert.equal((await a.api.get("/admin/usuarios", { token: a.token })).status, 403);
  });

  test("buscar y filtrar por rol", async () => {
    const a = await cuenta("adm", "admin");
    await cuenta("lucia", "cliente");
    await cuenta("pedro", "usuario");
    const r1 = await a.api.get("/admin/usuarios?buscar=LUC", { token: a.token });
    assert.deepEqual(r1.body.data.usuarios.map((x) => x.name), ["lucia"]);
    const r2 = await a.api.get("/admin/usuarios?rol=usuario", { token: a.token });
    assert.deepEqual(r2.body.data.usuarios.map((x) => x.name), ["pedro"]);
    assert.equal((await a.api.get("/admin/usuarios?rol=jefe", { token: a.token })).status, 400);
    const r3 = await a.api.get("/admin/usuarios?buscar=%25", { token: a.token });
    assert.equal(r3.body.data.total, 0, "el % se escapa, no es comodín");
  });
});

describe("cambiar rol", () => {
  test("admin: usuario ↔ cliente sí; asignar admin o tocar admins/superadmin no", async () => {
    const a = await cuenta("adm", "admin");
    const u = await cuenta("usu", "usuario");
    const otro = await cuenta("adm2", "admin");
    const s = await cuenta("sup", "superadmin");

    const r = await a.api.patch(`/admin/usuarios/${u.id}/rol`, { rol: "cliente" }, { token: a.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.rol, "cliente");
    assert.equal((await a.api.patch(`/admin/usuarios/${u.id}/rol`, { rol: "usuario" }, { token: a.token })).status, 200);

    assert.equal((await a.api.patch(`/admin/usuarios/${u.id}/rol`, { rol: "admin" }, { token: a.token })).status, 403);
    assert.equal((await a.api.patch(`/admin/usuarios/${otro.id}/rol`, { rol: "usuario" }, { token: a.token })).status, 403);
    assert.equal((await a.api.patch(`/admin/usuarios/${s.id}/rol`, { rol: "usuario" }, { token: a.token })).status, 403);
  });

  test("superadmin: nombra y quita admins; nadie asigna superadmin ni se cambia a sí mismo", async () => {
    const s = await cuenta("sup", "superadmin");
    const s2 = await cuenta("sup2", "superadmin");
    const u = await cuenta("usu", "usuario");

    assert.equal((await s.api.patch(`/admin/usuarios/${u.id}/rol`, { rol: "admin" }, { token: s.token })).body.data.rol, "admin");
    assert.equal((await s.api.patch(`/admin/usuarios/${u.id}/rol`, { rol: "superadmin" }, { token: s.token })).status, 403);
    assert.equal((await s.api.patch(`/admin/usuarios/${s.id}/rol`, { rol: "usuario" }, { token: s.token })).status, 403);
    assert.equal((await s.api.patch(`/admin/usuarios/${s2.id}/rol`, { rol: "admin" }, { token: s.token })).status, 403);
  });

  test("quitarle admin a alguien cierra sus sesiones al instante", async () => {
    const s = await cuenta("sup", "superadmin");
    const a = await cuenta("adm", "admin");
    await s.api.patch(`/admin/usuarios/${a.id}/rol`, { rol: "cliente" }, { token: s.token });
    assert.equal((await a.api.post("/auth/refresh")).status, 401);
  });

  test("permisos que devuelve la API para pintar la UI", async () => {
    const a = await cuenta("adm", "admin");
    const u = await cuenta("usu", "usuario");
    const { body } = await a.api.get(`/admin/usuarios/${u.id}`, { token: a.token });
    assert.deepEqual(body.data.permisos, { gestionar: true, rolesAsignables: ["usuario", "cliente"] });
    const yo = await a.api.get(`/admin/usuarios/${a.id}`, { token: a.token });
    assert.deepEqual(yo.body.data.permisos, { gestionar: false, rolesAsignables: [] });
    assert.equal((await a.api.get("/admin/usuarios/9999", { token: a.token })).status, 404);
    assert.equal((await a.api.get("/admin/usuarios/abc", { token: a.token })).status, 404);
  });
});

describe("bloquear", () => {
  test("bloquear cierra sesiones e impide entrar; desbloquear lo revierte", async () => {
    const a = await cuenta("adm", "admin");
    const c = await cuenta("cli", "cliente");
    const r = await a.api.patch(`/admin/usuarios/${c.id}/bloqueo`, { bloqueado: true }, { token: a.token });
    assert.equal(r.body.data.bloqueado, true);
    assert.equal((await c.api.post("/auth/refresh")).status, 401);
    await pool.query("DELETE FROM rate_limits");
    assert.equal((await cliente(ctx.base).post("/auth/login", { email: c.email, password: PASS })).status, 403);

    await a.api.patch(`/admin/usuarios/${c.id}/bloqueo`, { bloqueado: false }, { token: a.token });
    assert.equal((await cliente(ctx.base).post("/auth/login", { email: c.email, password: PASS })).status, 200);
  });

  test("un admin no puede bloquear a otro admin ni a sí mismo; valida el body", async () => {
    const a = await cuenta("adm", "admin");
    const otro = await cuenta("adm2", "admin");
    assert.equal((await a.api.patch(`/admin/usuarios/${otro.id}/bloqueo`, { bloqueado: true }, { token: a.token })).status, 403);
    assert.equal((await a.api.patch(`/admin/usuarios/${a.id}/bloqueo`, { bloqueado: true }, { token: a.token })).status, 403);
    assert.equal((await a.api.patch(`/admin/usuarios/${otro.id}/bloqueo`, { bloqueado: "si" }, { token: a.token })).status, 400);
  });
});

describe("perfil propio (PATCH /auth/me)", () => {
  test("actualiza nombre y teléfono; valida; no toca email ni rol", async () => {
    const u = await cuenta("usu", "usuario");
    const r = await u.api.patch("/auth/me", { name: "  Ana   María ", telefono: "+57 300 123 4567", rol: "superadmin", email: "x@x.com" }, { token: u.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.name, "Ana María");
    assert.equal(r.body.data.telefono, "+57 300 123 4567");
    assert.equal(r.body.data.rol, "usuario");
    assert.equal(r.body.data.email, u.email);
    assert.equal((await u.api.patch("/auth/me", { name: "A" }, { token: u.token })).status, 400);
    assert.equal((await u.api.patch("/auth/me", { telefono: "abc" }, { token: u.token })).status, 400);
    assert.equal((await u.api.patch("/auth/me", {}, { token: u.token })).status, 400);
    assert.equal((await u.api.patch("/auth/me", { telefono: "" }, { token: u.token })).body.data.telefono, null);
  });
});

describe("script de roles", () => {
  test("asigna superadmin desde la línea de comandos", async () => {
    const u = await cuenta("usu", "usuario");
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, ["src/scripts/rol.js", u.email, "superadmin"], { env: process.env });
    assert.match(stdout, /usuario → superadmin/);
    const { rows } = await pool.query("SELECT rol FROM usuarios WHERE id = $1", [u.id]);
    assert.equal(rows[0].rol, "superadmin");
    await assert.rejects(run(process.execPath, ["src/scripts/rol.js", u.email, "jefe"], { env: process.env }), /Rol no válido/);
  });
});
