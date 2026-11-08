// src/controllers/admin.clientes.controllers.js — /admin: clientes, catálogo,
// proyectos y "convertir solicitud en proyecto" (admin y superadmin).
import { pool, enTransaccion } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import * as v from "../lib/validar.js";
import {
  ESTADOS_CLIENTE,
  ETIQUETA_CAMPO,
  ETIQUETA_ESTADO_PROYECTO,
  MODELOS_COBRO,
  MONEDAS,
  PERIODICIDADES,
  PROYECTO_ACTIVO,
  actividadDe,
  actualizarCliente,
  ascenderACliente,
  avisarProyectoActualizado,
  avisarProyectoCreado,
  crearProyecto,
  detalleProyecto,
  diferencias,
  guardarHitos,
  registrarActividad,
  validarFicha,
  validarProyecto,
} from "../services/clientes.service.js";

const POR_PAGINA = 20;
const idValido = (x, msg) => {
  const n = Number(x);
  if (!Number.isInteger(n) || n <= 0) throw notFound(msg);
  return n;
};
const nombreCorto = (actor) => actor.name.split(" ")[0];

async function buscarCliente(id, db = pool) {
  const { rows } = await db.query("SELECT * FROM clientes WHERE id = $1", [idValido(id, "Cliente no encontrado.")]);
  if (!rows[0]) throw notFound("Cliente no encontrado.");
  return rows[0];
}

async function equipoActivo() {
  const { rows } = await pool.query(
    "SELECT id, name FROM usuarios WHERE rol IN ('admin', 'superadmin') AND NOT bloqueado ORDER BY name",
  );
  return rows;
}

async function fichaAdmin(c) {
  const { rows: [cuenta] } = c.usuario_id
    ? await pool.query("SELECT id, name, email, rol, bloqueado, email_verificado FROM usuarios WHERE id = $1", [c.usuario_id])
    : { rows: [null] };
  const { rows: proyectos } = await pool.query(
    `SELECT p.id, p.codigo, p.nombre, p.tipo_proyecto, p.estado, p.progreso, p.modelo_cobro, p.valor_total,
            p.importe_periodo, p.periodicidad, p.moneda, p.fecha_inicio, p.fecha_entrega_estimada,
            r.name AS responsable, s.codigo AS solicitud_codigo
       FROM proyectos p
       LEFT JOIN usuarios r ON r.id = p.responsable_id
       LEFT JOIN solicitudes s ON s.id = p.solicitud_id
      WHERE p.cliente_id = $1 ORDER BY p.created_at DESC`,
    [c.id],
  );
  const { rows: solicitudes } = await pool.query(
    `SELECT id, codigo, tipo_proyecto, estado, created_at FROM solicitudes
      WHERE usuario_id = $1 OR email = $2 ORDER BY created_at DESC LIMIT 20`,
    [c.usuario_id ?? 0, c.email],
  );
  const { rows: [alta] } = c.alta_por
    ? await pool.query("SELECT name FROM usuarios WHERE id = $1", [c.alta_por])
    : { rows: [null] };
  return { ...c, alta_por_nombre: alta?.name ?? null, cuenta, proyectos, solicitudes, actividad: await actividadDe(c.id) };
}

// ═════════════════════════ Clientes ═════════════════════════════

// ── GET /admin/clientes?buscar=&estado=&pagina= ──────────────────
export const listarClientes = async (req, res) => {
  const estado = String(req.query.estado ?? "").trim();
  const texto = String(req.query.buscar ?? "").trim().slice(0, 100);
  const pagina = Math.max(1, Number.parseInt(req.query.pagina, 10) || 1);
  if (estado && !ESTADOS_CLIENTE.includes(estado)) throw badRequest("Estado no válido.");

  const filtros = [];
  const valores = [];
  if (estado) {
    valores.push(estado);
    filtros.push(`c.estado = $${valores.length}`);
  }
  if (texto) {
    valores.push(`%${texto.replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
    const i = valores.length;
    filtros.push(`(c.nombre ILIKE $${i} OR c.nombre_comercial ILIKE $${i} OR c.email ILIKE $${i} OR c.numero_documento ILIKE $${i})`);
  }
  const where = filtros.length ? `WHERE ${filtros.join(" AND ")}` : "";
  const { rows: [{ total }] } = await pool.query(`SELECT count(*)::int AS total FROM clientes c ${where}`, valores);
  valores.push(PROYECTO_ACTIVO, POR_PAGINA, (pagina - 1) * POR_PAGINA);
  const n = valores.length;
  const { rows } = await pool.query(
    `SELECT c.id, c.nombre, c.nombre_comercial, c.email, c.tipo_persona, c.tipo_documento, c.numero_documento, c.dv,
            c.ciudad, c.estado, c.created_at, c.usuario_id IS NOT NULL AS tiene_cuenta,
            (SELECT count(*)::int FROM proyectos p WHERE p.cliente_id = c.id) AS proyectos,
            (SELECT count(*)::int FROM proyectos p WHERE p.cliente_id = c.id AND p.estado = ANY($${n - 2})) AS proyectos_activos
       FROM clientes c ${where}
      ORDER BY (c.estado = 'activo') DESC, c.created_at DESC
      LIMIT $${n - 1} OFFSET $${n}`,
    valores,
  );
  const { rows: conteos } = await pool.query("SELECT estado, count(*)::int AS n FROM clientes GROUP BY estado");
  res.json({
    success: true,
    data: {
      clientes: rows,
      total,
      pagina,
      paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
      conteos: Object.fromEntries(ESTADOS_CLIENTE.map((e) => [e, conteos.find((c) => c.estado === e)?.n ?? 0])),
    },
  });
};

/**
 * Crea la ficha dentro de `db`. Si ya existe una cuenta con ese email, la vincula
 * y la sube a "cliente". Lanza 409 si el email ya es de otro cliente.
 */
async function crearFicha(db, { email, ficha, actor }) {
  const { rows: [existe] } = await db.query("SELECT id FROM clientes WHERE email = $1", [email]);
  if (existe) throw conflict("Ya hay un cliente con ese email.");
  const { rows: [cuenta] } = await db.query(
    "SELECT id, email_verificado FROM usuarios WHERE email = $1",
    [email],
  );
  // Solo se vincula a una cuenta con el email verificado; si no, al verificarlo.
  const usuarioId = cuenta?.email_verificado ? cuenta.id : null;
  const campos = Object.keys(ficha);
  let fila;
  try {
    ({ rows: [fila] } = await db.query(
      `INSERT INTO clientes (email, usuario_id, alta_por${campos.map((c) => `, ${c}`).join("")})
       VALUES ($1, $2, $3${campos.map((_, i) => `, $${i + 4}`).join("")}) RETURNING *`,
      [email, usuarioId, actor.id, ...campos.map((c) => ficha[c])],
    ));
  } catch (e) {
    if (e.code === "23505" && /documento/.test(e.constraint ?? "")) throw conflict("Ya hay un cliente con ese documento.");
    if (e.code === "23505" && /usuario_id/.test(e.constraint ?? "")) throw conflict("Esa cuenta ya tiene ficha de cliente.");
    throw e;
  }
  if (usuarioId) await ascenderACliente(db, usuarioId);
  await registrarActividad(db, {
    cliente_id: fila.id, actor_id: actor.id, entidad: "cliente", entidad_id: fila.id,
    accion: "cliente_alta", descripcion: `${nombreCorto(actor)} dio de alta la ficha de cliente`,
    visible_cliente: true,
  });
  return fila;
}

// ── POST /admin/clientes { email, ...ficha } ─────────────────────
export const crearCliente = async (req, res) => {
  let email;
  try {
    email = v.email(req.body?.email, { requerido: true });
  } catch (e) {
    throw badRequest("Revisa los datos marcados.", { errores: { email: e } });
  }
  const ficha = validarFicha(req.body, { equipo: true });
  const fila = await enTransaccion((db) => crearFicha(db, { email, ficha, actor: req.actor }));
  res.status(201).json({ success: true, message: "Cliente creado.", data: await fichaAdmin(fila) });
};

// ── GET /admin/clientes/:id ──────────────────────────────────────
export const verCliente = async (req, res) => {
  const c = await buscarCliente(req.params.id);
  res.json({ success: true, data: { ...(await fichaAdmin(c)), equipo: await equipoActivo() } });
};

// ── PATCH /admin/clientes/:id ────────────────────────────────────
export const editarCliente = async (req, res) => {
  const c = await buscarCliente(req.params.id);
  const cambios = validarFicha(req.body, { equipo: true, parcial: true });
  const diff = diferencias(c, cambios);
  const claves = Object.keys(diff);
  if (!claves.length) return res.json({ success: true, message: "Sin cambios.", data: await fichaAdmin(c) });

  const fila = await enTransaccion(async (db) => {
    let nueva;
    try {
      nueva = await actualizarCliente(db, c.id, Object.fromEntries(claves.map((k) => [k, cambios[k]])));
    } catch (e) {
      if (e.code === "23505") throw conflict("Ya hay un cliente con ese documento.");
      throw e;
    }
    const soloInternas = claves.every((k) => k === "notas_internas");
    await registrarActividad(db, {
      cliente_id: c.id, actor_id: req.actor.id, entidad: "cliente", entidad_id: c.id,
      accion: "ficha_editada",
      descripcion: `${nombreCorto(req.actor)} actualizó: ${claves.map((k) => ETIQUETA_CAMPO[k] ?? k).join(", ")}`,
      datos: diff,
      // Las notas internas y el estado nunca aparecen en el historial del cliente.
      visible_cliente: !soloInternas && !claves.includes("notas_internas") && !claves.includes("estado"),
    });
    return nueva;
  });
  res.json({ success: true, message: "Cliente actualizado.", data: await fichaAdmin(fila) });
};

// ═════════════════════════ Catálogo ═════════════════════════════

const REGLAS_SERVICIO = {
  nombre: (x) => v.texto(x, { max: 120, min: 2, requerido: true, nombre: "El nombre" }),
  categoria: (x) => v.opcion(x, ["proyecto", "recurrente"], { nombre: "La categoría" }) ?? "proyecto",
  tipo_proyecto: (x) => v.texto(x, { max: 40, nombre: "El tipo de proyecto" }),
  descripcion: (x) => v.parrafo(x, { max: 3000, nombre: "La descripción" }),
  incluye: (x) => v.lista(x, { nombre: "Lo que incluye" }),
  modelo_cobro: (x) => v.opcion(x, MODELOS_COBRO, { nombre: "El modelo de cobro" }) ?? "unico",
  precio_base: (x) => v.dinero(x, { nombre: "El precio" }),
  moneda: (x) => v.opcion(x, MONEDAS, { nombre: "La moneda" }) ?? "COP",
  periodicidad: (x) => v.opcion(x, PERIODICIDADES, { nombre: "La periodicidad" }),
  activo: (x) => (x === undefined || x === null ? true : x === true),
};

function validarServicio(body, parcial) {
  const { datos, errores } = v.aplicar(body, REGLAS_SERVICIO, { parcial });
  if (Object.keys(errores).length) throw badRequest("Revisa los datos del servicio.", { errores });
  return datos;
}

// ── GET /admin/servicios?todos=1 ─────────────────────────────────
export const listarServicios = async (req, res) => {
  const todos = req.query.todos === "1";
  const { rows } = await pool.query(
    `SELECT * FROM servicios_catalogo ${todos ? "" : "WHERE activo"} ORDER BY activo DESC, categoria, nombre`,
  );
  res.json({ success: true, data: rows });
};

// ── POST /admin/servicios ────────────────────────────────────────
export const crearServicio = async (req, res) => {
  const d = validarServicio(req.body, false);
  const campos = Object.keys(d);
  const { rows: [s] } = await pool.query(
    `INSERT INTO servicios_catalogo (${campos.join(", ")}) VALUES (${campos.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
    campos.map((c) => d[c]),
  );
  res.status(201).json({ success: true, message: "Servicio creado.", data: s });
};

// ── PATCH /admin/servicios/:id ───────────────────────────────────
export const editarServicio = async (req, res) => {
  const id = idValido(req.params.id, "Servicio no encontrado.");
  const d = validarServicio(req.body, true);
  const campos = Object.keys(d);
  if (!campos.length) throw badRequest("No hay cambios.");
  const { rows: [s] } = await pool.query(
    `UPDATE servicios_catalogo SET ${campos.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
    [id, ...campos.map((c) => d[c])],
  );
  if (!s) throw notFound("Servicio no encontrado.");
  res.json({ success: true, message: "Servicio actualizado.", data: s });
};

// ═════════════════════════ Proyectos ════════════════════════════

async function buscarProyecto(id, db = pool) {
  const { rows } = await db.query("SELECT * FROM proyectos WHERE id = $1", [idValido(id, "Proyecto no encontrado.")]);
  if (!rows[0]) throw notFound("Proyecto no encontrado.");
  return rows[0];
}

// ── GET /admin/proyectos/:id ─────────────────────────────────────
export const verProyecto = async (req, res) => {
  const p = await buscarProyecto(req.params.id);
  const { rows: [cliente] } = await pool.query("SELECT id, nombre, email FROM clientes WHERE id = $1", [p.cliente_id]);
  res.json({ success: true, data: { ...(await detalleProyecto(pool, p.id)), cliente, equipo: await equipoActivo() } });
};

// ── POST /admin/proyectos { cliente_id, ...proyecto, hitos? } ────
export const crearProyectoAdmin = async (req, res) => {
  const cliente = await buscarCliente(req.body?.cliente_id);
  const { datos, hitos } = await validarProyecto(req.body);
  const p = await enTransaccion(async (db) => {
    const nuevo = await crearProyecto(db, { cliente_id: cliente.id, creado_por: req.actor.id, datos, hitos: hitos ?? [] });
    await registrarActividad(db, {
      cliente_id: cliente.id, actor_id: req.actor.id, entidad: "proyecto", entidad_id: nuevo.id,
      accion: "proyecto_creado", descripcion: `Proyecto ${nuevo.codigo} creado: ${nuevo.nombre}`,
      visible_cliente: true,
    });
    return nuevo;
  });
  avisarProyectoCreado(p, cliente).catch((e) => console.error("❌ Aviso de proyecto creado:", e.message));
  res.status(201).json({ success: true, message: `Proyecto ${p.codigo} creado.`, data: await detalleProyecto(pool, p.id) });
};

// ── PATCH /admin/proyectos/:id { ...campos, hitos? } ─────────────
export const editarProyecto = async (req, res) => {
  const p = await buscarProyecto(req.params.id);
  const { datos, hitos } = await validarProyecto(req.body, { parcial: true });
  const diff = diferencias(p, datos);
  const claves = Object.keys(diff);

  const { completados } = await enTransaccion(async (db) => {
    if (claves.length) {
      await db.query(
        `UPDATE proyectos SET ${claves.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`,
        [p.id, ...claves.map((k) => datos[k])],
      );
    }
    const hechos = hitos ? await guardarHitos(db, p.id, hitos) : [];
    if (diff.estado) {
      await registrarActividad(db, {
        cliente_id: p.cliente_id, actor_id: req.actor.id, entidad: "proyecto", entidad_id: p.id,
        accion: "proyecto_estado",
        descripcion: `${p.codigo} pasó a «${ETIQUETA_ESTADO_PROYECTO[datos.estado]}»`,
        datos: { estado: diff.estado }, visible_cliente: true,
      });
    }
    for (const nombre of hechos) {
      await registrarActividad(db, {
        cliente_id: p.cliente_id, actor_id: req.actor.id, entidad: "proyecto", entidad_id: p.id,
        accion: "hito_completado", descripcion: `Hito completado en ${p.codigo}: ${nombre}`, visible_cliente: true,
      });
    }
    const otros = claves.filter((k) => k !== "estado");
    if (otros.length) {
      await registrarActividad(db, {
        cliente_id: p.cliente_id, actor_id: req.actor.id, entidad: "proyecto", entidad_id: p.id,
        accion: "proyecto_editado",
        descripcion: `${nombreCorto(req.actor)} editó ${p.codigo}: ${otros.join(", ")}`,
        datos: Object.fromEntries(otros.map((k) => [k, diff[k]])), visible_cliente: false,
      });
    }
    return { completados: hechos };
  });

  if (diff.estado || completados.length) {
    const { rows: [cliente] } = await pool.query("SELECT * FROM clientes WHERE id = $1", [p.cliente_id]);
    avisarProyectoActualizado(p, cliente, { estado: diff.estado ? datos.estado : null, hitosCompletados: completados })
      .catch((e) => console.error("❌ Aviso de proyecto:", e.message));
  }
  res.json({ success: true, message: "Proyecto actualizado.", data: await detalleProyecto(pool, p.id) });
};

// ═══════════════ Solicitud aceptada → cliente + proyecto ═════════

// ── POST /admin/solicitudes/:id/convertir { cliente: {...}, proyecto: {..., hitos} }
export const convertirSolicitud = async (req, res) => {
  const sid = idValido(req.params.id, "Solicitud no encontrada.");
  const { rows: [s] } = await pool.query("SELECT * FROM solicitudes WHERE id = $1", [sid]);
  if (!s) throw notFound("Solicitud no encontrada.");
  if (["rechazada", "archivada"].includes(s.estado)) throw badRequest("No se puede convertir una solicitud rechazada o archivada.");
  const { rows: [ya] } = await pool.query("SELECT codigo FROM proyectos WHERE solicitud_id = $1", [s.id]);
  if (ya) throw conflict(`Esta solicitud ya es el proyecto ${ya.codigo}.`);

  // Datos de la ficha: lo que mande el admin, con la solicitud como base.
  const base = { nombre: s.empresa || s.nombre, telefono: s.telefono, contacto_nombre: s.empresa ? s.nombre : null };
  const ficha = validarFicha({ ...base, ...(req.body?.cliente ?? {}) }, { equipo: true, parcial: true });
  const { datos, hitos } = await validarProyecto({
    tipo_proyecto: s.tipo_proyecto,
    descripcion: s.descripcion,
    estado: "en_curso",
    ...(req.body?.proyecto ?? {}),
  });

  const { proyecto, cliente } = await enTransaccion(async (db) => {
    // Cliente: el de la cuenta de la solicitud, o el de su email, o uno nuevo.
    const { rows: [existente] } = await db.query(
      "SELECT * FROM clientes WHERE (usuario_id IS NOT NULL AND usuario_id = $1) OR email = $2 ORDER BY usuario_id NULLS LAST LIMIT 1",
      [s.usuario_id ?? 0, s.email],
    );
    let c;
    if (existente) {
      // Completa los huecos de la ficha sin pisar lo que ya tenía.
      const huecos = Object.fromEntries(Object.entries(ficha).filter(([k, val]) => val != null && existente[k] == null));
      c = await actualizarCliente(db, existente.id, huecos);
      if (c.usuario_id) await ascenderACliente(db, c.usuario_id);
    } else {
      const { rows: [cuenta] } = s.usuario_id
        ? await db.query("SELECT email FROM usuarios WHERE id = $1", [s.usuario_id])
        : { rows: [null] };
      c = await crearFicha(db, { email: cuenta?.email ?? s.email, ficha: { nombre: s.nombre, ...ficha }, actor: req.actor });
    }

    const p = await crearProyecto(db, { cliente_id: c.id, solicitud_id: s.id, creado_por: req.actor.id, datos, hitos: hitos ?? [] });
    await db.query("UPDATE solicitudes SET estado = 'aceptada', asignado_a = COALESCE(asignado_a, $2) WHERE id = $1", [s.id, req.actor.id]);
    await registrarActividad(db, {
      cliente_id: c.id, actor_id: req.actor.id, entidad: "proyecto", entidad_id: p.id,
      accion: "proyecto_creado", descripcion: `Proyecto ${p.codigo} creado desde la solicitud ${s.codigo}: ${p.nombre}`,
      datos: { solicitud: s.codigo }, visible_cliente: true,
    });
    return { proyecto: p, cliente: c };
  });

  avisarProyectoCreado(proyecto, cliente).catch((e) => console.error("❌ Aviso de proyecto creado:", e.message));
  res.status(201).json({
    success: true,
    message: `Proyecto ${proyecto.codigo} creado para ${cliente.nombre}.`,
    data: { proyecto: { id: proyecto.id, codigo: proyecto.codigo }, cliente: { id: cliente.id, nombre: cliente.nombre } },
  });
};
