// test/clientes.test.js — F1 de docs/CLIENTES.md: convertir solicitud en proyecto,
// ficha de cliente (equipo y propio cliente), vinculación por email, proyectos,
// hitos, historial, catálogo y aislamiento entre clientes.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bandejaPruebas, cliente, iniciar, limpiarBD, pool, ultimoCodigo } from "./helpers.js";

let ctx;
before(async () => { ctx = await iniciar(); });
after(async () => { await ctx.cerrar(); });
beforeEach(async () => {
  await limpiarBD();
  await pool.query("TRUNCATE servicios_catalogo RESTART IDENTITY CASCADE");
});

const PASS = "clave1234";
const esperar = (ms = 80) => new Promise((r) => setTimeout(r, ms));

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

async function solicitud({ email, usuario_id = null, estado = "respondida", nombre = "Laura Gómez" }) {
  const { rows: [s] } = await pool.query(
    `INSERT INTO solicitudes (email, usuario_id, nombre, telefono, tipo_proyecto, descripcion, estado)
     VALUES ($1, $2, $3, '+57 300 000 0000', 'Página web', 'Web corporativa con blog y formulario.', $4) RETURNING *`,
    [email, usuario_id, nombre, estado],
  );
  return s;
}

const PROYECTO = {
  nombre: "Web corporativa Gómez",
  modelo_cobro: "hitos",
  valor_total: 4800000,
  fecha_inicio: "2026-11-15",
  fecha_entrega_estimada: "2026-12-20",
  incluye: ["Diseño a medida", "Formulario de contacto"],
  hitos: [
    { nombre: "Anticipo y arranque", porcentaje_cobro: 50, fecha_prevista: "2026-11-15" },
    { nombre: "Entrega y publicación", porcentaje_cobro: 50, fecha_prevista: "2026-12-20" },
  ],
};

describe("convertir solicitud en proyecto", () => {
  test("con cuenta: crea ficha vinculada, sube a cliente, crea proyecto con hitos y avisa", async () => {
    const adm = await cuenta("adm", "admin");
    const laura = await cuenta("laura");
    const s = await solicitud({ email: laura.email, usuario_id: laura.id });
    bandejaPruebas.length = 0;

    const r = await adm.api.post(`/admin/solicitudes/${s.id}/convertir`, {
      cliente: { tipo_documento: "CC", numero_documento: "1.020.345.678", ciudad: "Bogotá" },
      proyecto: PROYECTO,
    }, { token: adm.token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.data.proyecto.codigo, /^P-\d{4,}$/);
    await esperar();

    const { rows: [c] } = await pool.query("SELECT * FROM clientes");
    assert.equal(c.usuario_id, laura.id);
    assert.equal(c.email, laura.email);
    assert.equal(c.numero_documento, "1020345678", "normaliza el documento");
    assert.equal(c.telefono, "+57 300 000 0000", "toma el teléfono de la solicitud");
    const { rows: [u] } = await pool.query("SELECT rol FROM usuarios WHERE id = $1", [laura.id]);
    assert.equal(u.rol, "cliente");

    const { rows: [p] } = await pool.query("SELECT * FROM proyectos");
    assert.equal(p.solicitud_id, s.id);
    assert.equal(p.estado, "en_curso");
    assert.equal(p.tipo_proyecto, "Página web");
    assert.equal(p.valor_total, 4800000);
    assert.equal(p.fecha_inicio, "2026-11-15");
    const { rows: hitos } = await pool.query("SELECT nombre, orden FROM proyecto_hitos ORDER BY orden");
    assert.deepEqual(hitos.map((h) => h.nombre), ["Anticipo y arranque", "Entrega y publicación"]);

    const { rows: [sol] } = await pool.query("SELECT estado FROM solicitudes WHERE id = $1", [s.id]);
    assert.equal(sol.estado, "aceptada");

    const { rows: notifs } = await pool.query("SELECT usuario_id, tipo, url FROM notificaciones WHERE tipo = 'proyecto_creado'");
    assert.equal(notifs[0].usuario_id, laura.id);
    assert.equal(notifs[0].url, `/area-cliente?seccion=proyectos&proyecto=${p.codigo}`);
    const mail = bandejaPruebas.find((m) => m.to === laura.email);
    assert.match(mail.subject, new RegExp(`Tu proyecto ${p.codigo}`));

    const det = await adm.api.get(`/admin/solicitudes/${s.id}`, { token: adm.token });
    assert.equal(det.body.data.proyecto.codigo, p.codigo, "la solicitud enlaza a su proyecto");
  });

  test("dos veces → 409; rechazada → 400; hitos > 100 % → 400", async () => {
    const adm = await cuenta("adm", "admin");
    const s = await solicitud({ email: "x@ejemplo.com" });
    const ok = await adm.api.post(`/admin/solicitudes/${s.id}/convertir`, { proyecto: { nombre: "Uno" } }, { token: adm.token });
    assert.equal(ok.status, 201);
    const otra = await adm.api.post(`/admin/solicitudes/${s.id}/convertir`, { proyecto: { nombre: "Dos" } }, { token: adm.token });
    assert.equal(otra.status, 409);

    const r = await solicitud({ email: "y@ejemplo.com", estado: "rechazada" });
    assert.equal((await adm.api.post(`/admin/solicitudes/${r.id}/convertir`, { proyecto: { nombre: "X" } }, { token: adm.token })).status, 400);

    const s2 = await solicitud({ email: "z@ejemplo.com" });
    const mal = await adm.api.post(`/admin/solicitudes/${s2.id}/convertir`, {
      proyecto: { nombre: "Z", hitos: [{ nombre: "A", porcentaje_cobro: 70 }, { nombre: "B", porcentaje_cobro: 40 }] },
    }, { token: adm.token });
    assert.equal(mal.status, 400);
    assert.ok(mal.body.data.errores.hitos);
  });

  test("sin cuenta: la ficha queda por email y se vincula al verificar el registro (rol cliente en el token)", async () => {
    const adm = await cuenta("adm", "admin");
    const s = await solicitud({ email: "nueva@ejemplo.com", nombre: "Nueva Persona" });
    await adm.api.post(`/admin/solicitudes/${s.id}/convertir`, { proyecto: PROYECTO }, { token: adm.token });
    await esperar();
    const { rows: [c0] } = await pool.query("SELECT usuario_id FROM clientes");
    assert.equal(c0.usuario_id, null);
    const invitacion = bandejaPruebas.find((m) => m.to === "nueva@ejemplo.com");
    assert.match(invitacion.html, /registro\?email=nueva%40ejemplo\.com/);

    const api = cliente(ctx.base);
    await api.post("/auth/registro", { name: "Nueva Persona", email: "nueva@ejemplo.com", password: PASS });
    const v = await api.post("/auth/verificar-email", { email: "nueva@ejemplo.com", codigo: ultimoCodigo("nueva@ejemplo.com") });
    assert.equal(v.status, 200);
    assert.equal(v.body.data.usuario.rol, "cliente");
    const token = v.body.data.accessToken;

    const mios = await api.get("/proyectos/mios", { token });
    assert.equal(mios.body.data.length, 1);
    assert.equal(mios.body.data[0].hitos, 2);
    const resumen = await api.get("/clientes/yo/resumen", { token });
    assert.equal(resumen.body.data.proyectos[0].siguiente_hito, "Anticipo y arranque");
    assert.ok(resumen.body.data.actividad.some((a) => a.accion === "cuenta_vinculada"));
  });

  test("la ficha ya existente solo se completa, no se pisa", async () => {
    const adm = await cuenta("adm", "admin");
    const laura = await cuenta("laura");
    await adm.api.post("/admin/clientes", { email: laura.email, nombre: "Laura G.", ciudad: "Medellín" }, { token: adm.token });
    const s = await solicitud({ email: laura.email, usuario_id: laura.id });
    await adm.api.post(`/admin/solicitudes/${s.id}/convertir`, {
      cliente: { ciudad: "Bogotá", direccion: "Calle 1" }, proyecto: { nombre: "Otro" },
    }, { token: adm.token });
    const { rows } = await pool.query("SELECT nombre, ciudad, direccion FROM clientes");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { nombre: "Laura G.", ciudad: "Medellín", direccion: "Calle 1" });
  });
});

describe("ficha de cliente", () => {
  test("el cliente edita sus datos de facturación pero no estado ni notas internas", async () => {
    const adm = await cuenta("adm", "admin");
    const laura = await cuenta("laura");
    await adm.api.post("/admin/clientes", {
      email: laura.email, nombre: "Laura Gómez", notas_internas: "Prefiere WhatsApp",
    }, { token: adm.token });

    const yo = await laura.api.get("/clientes/yo", { token: laura.token });
    assert.equal(yo.body.data.nombre, "Laura Gómez");
    assert.equal(yo.body.data.notas_internas, undefined, "no ve las notas internas");

    const r = await laura.api.patch("/clientes/yo", {
      tipo_persona: "juridica", nombre: "Gómez Estudio SAS", tipo_documento: "NIT", numero_documento: "901.234.567",
      dv: "1", email_facturacion: "Conta@Gomez.co", sitio_web: "gomez.co", estado: "baja", notas_internas: "hack",
    }, { token: laura.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { rows: [c] } = await pool.query("SELECT * FROM clientes");
    assert.equal(c.nombre, "Gómez Estudio SAS");
    assert.equal(c.numero_documento, "901234567");
    assert.equal(c.email_facturacion, "conta@gomez.co");
    assert.equal(c.sitio_web, "https://gomez.co");
    assert.equal(c.estado, "activo", "ignora el estado");
    assert.equal(c.notas_internas, "Prefiere WhatsApp", "ignora las notas internas");

    const { rows: [a] } = await pool.query("SELECT * FROM actividad WHERE accion = 'ficha_editada'");
    assert.equal(a.visible_cliente, true);
    assert.equal(a.datos.nombre.antes, "Laura Gómez");

    const mal = await laura.api.patch("/clientes/yo", { email_facturacion: "no", telefono: "x" }, { token: laura.token });
    assert.equal(mal.status, 400);
    assert.ok(mal.body.data.errores.email_facturacion && mal.body.data.errores.telefono);
  });

  test("un usuario sin ficha ve vacío y no puede editar", async () => {
    const u = await cuenta("usu");
    assert.equal((await u.api.get("/clientes/yo", { token: u.token })).body.data, null);
    assert.deepEqual((await u.api.get("/proyectos/mios", { token: u.token })).body.data, []);
    assert.equal((await u.api.patch("/clientes/yo", { nombre: "X Y" }, { token: u.token })).status, 404);
  });

  test("alta manual: vincula una cuenta verificada existente; email o documento repetidos → 409", async () => {
    const adm = await cuenta("adm", "admin");
    const pepe = await cuenta("pepe");
    const r = await adm.api.post("/admin/clientes", {
      email: "PEPE@ejemplo.com", nombre: "Pepe", tipo_documento: "CC", numero_documento: "123456",
    }, { token: adm.token });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.cuenta.id, pepe.id);
    const { rows: [u] } = await pool.query("SELECT rol FROM usuarios WHERE id = $1", [pepe.id]);
    assert.equal(u.rol, "cliente");

    assert.equal((await adm.api.post("/admin/clientes", { email: "pepe@ejemplo.com", nombre: "Otro" }, { token: adm.token })).status, 409);
    assert.equal((await adm.api.post("/admin/clientes", {
      email: "otro@ejemplo.com", nombre: "Otro", tipo_documento: "CC", numero_documento: "123.456",
    }, { token: adm.token })).status, 409);
  });

  test("las notas internas y el estado no salen en el historial del cliente", async () => {
    const adm = await cuenta("adm", "admin");
    const laura = await cuenta("laura");
    const { body: { data: c } } = await adm.api.post("/admin/clientes", { email: laura.email, nombre: "Laura" }, { token: adm.token });
    await adm.api.patch(`/admin/clientes/${c.id}`, { notas_internas: "Cliente difícil" }, { token: adm.token });
    await adm.api.patch(`/admin/clientes/${c.id}`, { estado: "pausado" }, { token: adm.token });
    await adm.api.patch(`/admin/clientes/${c.id}`, { ciudad: "Cali" }, { token: adm.token });
    const resumen = await laura.api.get("/clientes/yo/resumen", { token: laura.token });
    const textos = resumen.body.data.actividad.map((a) => a.descripcion).join(" | ");
    assert.doesNotMatch(textos, /notas|estado/);
    assert.match(textos, /ciudad/);
  });
});

describe("proyectos", () => {
  async function preparar() {
    const adm = await cuenta("adm", "admin");
    const laura = await cuenta("laura");
    const { body: { data: c } } = await adm.api.post("/admin/clientes", { email: laura.email, nombre: "Laura" }, { token: adm.token });
    const r = await adm.api.post("/admin/proyectos", { cliente_id: c.id, ...PROYECTO, estado: "en_curso" }, { token: adm.token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { adm, laura, c, p: r.body.data };
  }

  test("estado y hito completado: historial visible, avisos in-app y fecha de completado", async () => {
    const { adm, laura, p } = await preparar();
    const [h1, h2] = p.hitos;
    const r = await adm.api.patch(`/admin/proyectos/${p.id}`, {
      estado: "entregado", progreso: 100,
      hitos: [{ ...h1, estado: "completado" }, { ...h2 }, { nombre: "Soporte post-entrega" }],
    }, { token: adm.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await esperar();
    assert.equal(r.body.data.hitos.length, 3);
    assert.ok(r.body.data.hitos[0].fecha_completado);
    assert.equal(r.body.data.hitos[1].fecha_completado, null);

    const { rows: notifs } = await pool.query("SELECT tipo FROM notificaciones WHERE usuario_id = $1 ORDER BY id", [laura.id]);
    assert.deepEqual(notifs.map((n) => n.tipo).filter((t) => t !== "proyecto_creado"), ["proyecto_estado", "proyecto_hito"]);

    const det = await laura.api.get(`/proyectos/mios/${p.codigo}`, { token: laura.token });
    assert.equal(det.body.data.estado, "entregado");
    assert.equal(det.body.data.creado_por, undefined, "el cliente no ve campos internos");

    // Quitar un hito lo borra; un id de otro proyecto se rechaza.
    const r2 = await adm.api.patch(`/admin/proyectos/${p.id}`, { hitos: [r.body.data.hitos[0]] }, { token: adm.token });
    assert.equal(r2.body.data.hitos.length, 1);
    const ajeno = await adm.api.patch(`/admin/proyectos/${p.id}`, { hitos: [{ id: 999999, nombre: "Ajeno" }] }, { token: adm.token });
    assert.equal(ajeno.status, 400);
  });

  test("aislamiento: otro cliente no ve el proyecto ni por código; un cliente no entra a /admin", async () => {
    const { adm, p } = await preparar();
    const otro = await cuenta("otro");
    await adm.api.post("/admin/clientes", { email: otro.email, nombre: "Otro" }, { token: adm.token });
    await pool.query("DELETE FROM rate_limits");
    assert.equal((await otro.api.get(`/proyectos/mios/${p.codigo}`, { token: otro.token })).status, 404);
    assert.deepEqual((await otro.api.get("/proyectos/mios", { token: otro.token })).body.data, []);
    assert.equal((await otro.api.get("/admin/clientes", { token: otro.token })).status, 403);
    assert.equal((await otro.api.get(`/admin/proyectos/${p.id}`, { token: otro.token })).status, 403);
  });

  test("validación: responsable fuera del equipo, fechas al revés, cliente inexistente", async () => {
    const { adm, laura, c } = await preparar();
    const r = await adm.api.post("/admin/proyectos", {
      cliente_id: c.id, nombre: "X", responsable_id: laura.id, fecha_inicio: "2026-12-01", fecha_entrega_estimada: "2026-11-01",
    }, { token: adm.token });
    assert.equal(r.status, 400);
    assert.ok(r.body.data.errores.responsable_id && r.body.data.errores.fecha_entrega_estimada);
    assert.equal((await adm.api.post("/admin/proyectos", { cliente_id: 999999, nombre: "X" }, { token: adm.token })).status, 404);
  });
});

describe("catálogo", () => {
  test("crear, listar activos y desactivar", async () => {
    const adm = await cuenta("adm", "admin");
    const r = await adm.api.post("/admin/servicios", {
      nombre: "Mantenimiento Essential", categoria: "recurrente", modelo_cobro: "recurrente",
      precio_base: 350000, periodicidad: "mensual", incluye: ["Actualizaciones", "Copias semanales"],
    }, { token: adm.token });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.precio_base, 350000);
    assert.equal((await adm.api.get("/admin/servicios", { token: adm.token })).body.data.length, 1);
    await adm.api.patch(`/admin/servicios/${r.body.data.id}`, { activo: false }, { token: adm.token });
    assert.equal((await adm.api.get("/admin/servicios", { token: adm.token })).body.data.length, 0);
    assert.equal((await adm.api.get("/admin/servicios?todos=1", { token: adm.token })).body.data.length, 1);
  });
});
