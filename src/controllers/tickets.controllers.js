// src/controllers/tickets.controllers.js — soporte por tickets (F5 de docs/CLIENTES.md).
// Cliente: abrir tickets (ligados a un proyecto o no), conversar y ver los suyos.
// Equipo: responder o dejar notas internas, estado, prioridad y asignado.
import { enTransaccion, pool } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import * as v from "../lib/validar.js";
import { EQUIPO_EMAIL, FRONTEND_URL } from "../config.js";
import { escapeTg } from "../lib/telegram.js";
import { boton, escapeHtml, layout } from "../emails/layout.js";
import { clienteDeUsuario, registrarActividad } from "../services/clientes.service.js";
import { equipo, notificarEnSegundoPlano } from "../services/notificaciones.service.js";

export const CATEGORIAS = { incidencia: "Incidencia", cambio: "Solicitud de cambio", consulta: "Consulta", pagos: "Pagos" };
export const PRIORIDADES = ["baja", "normal", "alta", "urgente"];
export const ESTADOS = ["abierto", "en_progreso", "esperando_cliente", "resuelto", "cerrado"];
const ETIQUETA_ESTADO = { abierto: "Abierto", en_progreso: "En progreso", esperando_cliente: "Esperando tu respuesta", resuelto: "Resuelto", cerrado: "Cerrado" };
const ABIERTOS = ["abierto", "en_progreso", "esperando_cliente"];

const rutaCliente = (codigo) => `/area-cliente?seccion=soporte&ticket=${encodeURIComponent(codigo)}`;
const rutaAdmin = (id) => `/admin?seccion=soporte&ticket=${id}`;
const abs = (r) => `${FRONTEND_URL}${r}`;
const extracto = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cuerpoValido = (x) => v.parrafo(x, { max: 5000, nombre: "El mensaje" });

// ── Avisos ───────────────────────────────────────────────────────

async function avisarEquipo(t, { titulo, cuerpo, cliente }) {
  const prioridad = t.prioridad === "urgente" ? "🔴 " : t.prioridad === "alta" ? "🟠 " : "";
  notificarEnSegundoPlano({
    usuarios: await equipo(),
    tipo: "ticket_cliente",
    titulo,
    cuerpo: extracto(cuerpo, 140),
    url: rutaAdmin(t.id),
    datos: { ticket_id: t.id, codigo: t.codigo },
    email: {
      to: EQUIPO_EMAIL,
      subject: `${titulo} · ${t.asunto}`,
      text: `${titulo}\n${t.asunto}\n\n${cuerpo}\n\n${abs(rutaAdmin(t.id))}`,
      html: layout({
        titulo: `${t.codigo} · ${t.asunto}`,
        preheader: cliente,
        contenido: `<p><strong>${escapeHtml(titulo)}</strong></p>
          <p style="color:#71717a;">${escapeHtml(CATEGORIAS[t.categoria])} · prioridad ${escapeHtml(t.prioridad)}</p>
          <div style="margin:16px 0;padding:14px 16px;background:#f4f4f5;border-left:3px solid #00a49c;white-space:pre-wrap;">${escapeHtml(cuerpo)}</div>
          ${boton(abs(rutaAdmin(t.id)), "Abrir el ticket")}`,
      }),
    },
    telegram: {
      html: `${prioridad}🎧 <b>${escapeTg(titulo)}</b>\n${escapeTg(t.asunto)} · ${escapeTg(CATEGORIAS[t.categoria])}\n<i>${escapeTg(extracto(cuerpo))}</i>`,
      boton: { texto: "Abrir el ticket", url: abs(rutaAdmin(t.id)) },
    },
  });
}

async function avisarCliente(t, { titulo, cuerpo, email = true }) {
  const { rows: [c] } = await pool.query(
    `SELECT cl.email, cl.email_facturacion, cl.nombre, u.id, u.socket_id, u.name
       FROM clientes cl LEFT JOIN usuarios u ON u.id = cl.usuario_id AND NOT u.bloqueado WHERE cl.id = $1`,
    [t.cliente_id],
  );
  if (!c?.id) return;
  notificarEnSegundoPlano({
    usuarios: [c],
    tipo: "ticket_equipo",
    titulo,
    cuerpo: extracto(cuerpo, 140),
    url: rutaCliente(t.codigo),
    datos: { codigo: t.codigo },
    email: email ? {
      to: c.email,
      replyTo: EQUIPO_EMAIL,
      subject: `${titulo} · ${t.asunto}`,
      text: `${titulo}\n\n${cuerpo}\n\nResponde desde tu área de cliente: ${abs(rutaCliente(t.codigo))}`,
      html: layout({
        titulo: `Soporte · ${t.codigo}`,
        preheader: t.asunto,
        contenido: `<p>Hola ${escapeHtml(String(c.name || c.nombre).split(" ")[0])},</p>
          <p>${escapeHtml(titulo)} en tu ticket <strong>${escapeHtml(t.asunto)}</strong> (${escapeHtml(t.codigo)}):</p>
          <div style="margin:16px 0;padding:14px 16px;background:#f4f4f5;border-left:3px solid #00a49c;white-space:pre-wrap;">${escapeHtml(cuerpo)}</div>
          ${boton(abs(rutaCliente(t.codigo)), "Ver y responder")}`,
      }),
    } : undefined,
  });
}

// ── Consultas comunes ────────────────────────────────────────────

async function mensajesDe(ticketId, { verInternos }) {
  const { rows } = await pool.query(
    `SELECT m.id, m.cuerpo, m.de_equipo, m.interno, m.created_at, u.name AS autor
       FROM ticket_mensajes m LEFT JOIN usuarios u ON u.id = m.autor_id
      WHERE m.ticket_id = $1 ${verInternos ? "" : "AND NOT m.interno"} ORDER BY m.created_at, m.id`,
    [ticketId],
  );
  return rows;
}

const SELECT_TICKET = `
  SELECT t.*, p.codigo AS proyecto_codigo, p.nombre AS proyecto_nombre, a.name AS asignado,
         cl.nombre AS cliente
    FROM tickets t
    JOIN clientes cl ON cl.id = t.cliente_id
    LEFT JOIN proyectos p ON p.id = t.proyecto_id
    LEFT JOIN usuarios a ON a.id = t.asignado_a`;

// ═════════════════════════ Cliente ══════════════════════════════

async function miCliente(req) {
  const c = await clienteDeUsuario(req.actor.id);
  if (!c) throw notFound("Tu cuenta aún no tiene ficha de cliente.");
  return c;
}

async function miTicket(req, cliente) {
  const codigo = String(req.params.codigo ?? "").toUpperCase().slice(0, 12);
  const { rows: [t] } = await pool.query(`${SELECT_TICKET} WHERE t.codigo = $1 AND t.cliente_id = $2`, [codigo, cliente.id]);
  if (!t) throw notFound("Ticket no encontrado.");
  return t;
}

const publico = (t) => {
  const { asignado_a, creado_por, cliente_id, proyecto_id, ...resto } = t;
  return resto;
};

// ── GET /tickets/mios ────────────────────────────────────────────
export const misTickets = async (req, res) => {
  const cliente = await clienteDeUsuario(req.actor.id);
  if (!cliente) return res.json({ success: true, data: { tickets: [], proyectos: [] } });
  const { rows } = await pool.query(`${SELECT_TICKET} WHERE t.cliente_id = $1 ORDER BY (t.estado = ANY($2)) DESC, t.ultimo_mensaje_en DESC`, [cliente.id, ABIERTOS]);
  const { rows: proyectos } = await pool.query(
    "SELECT codigo, nombre FROM proyectos WHERE cliente_id = $1 AND estado NOT IN ('cancelado') ORDER BY created_at DESC",
    [cliente.id],
  );
  res.json({ success: true, data: { tickets: rows.map(publico), proyectos } });
};

// ── GET /tickets/mios/:codigo ────────────────────────────────────
export const verMiTicket = async (req, res) => {
  const t = await miTicket(req, await miCliente(req));
  res.json({ success: true, data: { ...publico(t), mensajes: await mensajesDe(t.id, { verInternos: false }) } });
};

// ── POST /tickets/mios { asunto, categoria, prioridad, proyecto, cuerpo }
export const crearTicket = async (req, res) => {
  const cliente = await miCliente(req);
  const { datos, errores } = v.aplicar(req.body, {
    asunto: (x) => v.texto(x, { max: 160, min: 4, requerido: true, nombre: "El asunto" }),
    categoria: (x) => v.opcion(x, Object.keys(CATEGORIAS), { nombre: "El tipo" }) ?? "consulta",
    prioridad: (x) => v.opcion(x, ["baja", "normal", "alta", "urgente"], { nombre: "La prioridad" }) ?? "normal",
    cuerpo: (x) => {
      const s = cuerpoValido(x);
      if (!s || s.length < 10) throw "Cuéntanos un poco más (mínimo 10 caracteres).";
      return s;
    },
    proyecto: (x) => v.texto(x, { max: 12, nombre: "El proyecto" }),
  });
  if (Object.keys(errores).length) throw badRequest("Revisa los datos del ticket.", { errores });
  let proyectoId = null;
  if (datos.proyecto) {
    const { rows: [p] } = await pool.query("SELECT id FROM proyectos WHERE codigo = $1 AND cliente_id = $2", [datos.proyecto.toUpperCase(), cliente.id]);
    if (!p) throw badRequest("Ese proyecto no es tuyo.", { errores: { proyecto: "Proyecto no válido." } });
    proyectoId = p.id;
  }
  const t = await enTransaccion(async (db) => {
    const { rows: [nuevo] } = await db.query(
      `INSERT INTO tickets (cliente_id, proyecto_id, creado_por, asunto, categoria, prioridad)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [cliente.id, proyectoId, req.actor.id, datos.asunto, datos.categoria, datos.prioridad],
    );
    await db.query("INSERT INTO ticket_mensajes (ticket_id, autor_id, cuerpo) VALUES ($1, $2, $3)", [nuevo.id, req.actor.id, datos.cuerpo]);
    await registrarActividad(db, {
      cliente_id: cliente.id, actor_id: req.actor.id, entidad: "ticket", entidad_id: nuevo.id, accion: "ticket_creado",
      descripcion: `Abriste el ticket ${nuevo.codigo}: ${nuevo.asunto}`, visible_cliente: true,
    });
    return nuevo;
  });
  avisarEquipo(t, { titulo: `Nuevo ticket ${t.codigo} de ${cliente.nombre}`, cuerpo: datos.cuerpo, cliente: cliente.nombre })
    .catch((e) => console.error("❌ Aviso de ticket:", e.message));
  res.status(201).json({ success: true, message: `Ticket ${t.codigo} creado. Te responderemos pronto.`, data: { codigo: t.codigo } });
};

// ── POST /tickets/mios/:codigo/mensajes { cuerpo } ───────────────
export const responderMiTicket = async (req, res) => {
  const cliente = await miCliente(req);
  const t = await miTicket(req, cliente);
  if (t.estado === "cerrado") throw conflict("Este ticket está cerrado. Abre uno nuevo si necesitas algo más.");
  let cuerpo;
  try {
    cuerpo = cuerpoValido(req.body?.cuerpo);
    if (!cuerpo || cuerpo.length < 2) throw "Escribe el mensaje.";
  } catch (e) {
    throw badRequest(e, { errores: { cuerpo: e } });
  }
  await enTransaccion(async (db) => {
    await db.query("INSERT INTO ticket_mensajes (ticket_id, autor_id, cuerpo) VALUES ($1, $2, $3)", [t.id, req.actor.id, cuerpo]);
    // Si estaba resuelto o esperando al cliente, vuelve a la cola del equipo.
    await db.query(
      `UPDATE tickets SET ultimo_mensaje_en = now(),
              estado = CASE WHEN estado IN ('resuelto', 'esperando_cliente') THEN 'abierto' ELSE estado END
        WHERE id = $1`,
      [t.id],
    );
  });
  avisarEquipo(t, { titulo: `${cliente.nombre} respondió en ${t.codigo}`, cuerpo, cliente: cliente.nombre })
    .catch((e) => console.error("❌ Aviso de ticket:", e.message));
  res.status(201).json({ success: true, message: "Mensaje enviado." });
};

// ═════════════════════════ Equipo ═══════════════════════════════

async function ticketPorId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw notFound("Ticket no encontrado.");
  const { rows: [t] } = await pool.query(`${SELECT_TICKET} WHERE t.id = $1`, [n]);
  if (!t) throw notFound("Ticket no encontrado.");
  return t;
}

async function detalleAdmin(t) {
  const { rows: miembros } = await pool.query("SELECT id, name FROM usuarios WHERE rol IN ('admin', 'superadmin') AND NOT bloqueado ORDER BY name");
  return { ...t, mensajes: await mensajesDe(t.id, { verInternos: true }), equipo: miembros };
}

// ── GET /admin/tickets?estado=abiertos|<estado> ──────────────────
export const listarTickets = async (req, res) => {
  const estado = String(req.query.estado ?? "abiertos");
  if (estado !== "abiertos" && estado !== "todos" && !ESTADOS.includes(estado)) throw badRequest("Estado no válido.");
  const filtro = estado === "todos" ? [] : estado === "abiertos" ? ABIERTOS : [estado];
  const { rows } = await pool.query(
    `${SELECT_TICKET} ${filtro.length ? "WHERE t.estado = ANY($1)" : ""}
      ORDER BY array_position(ARRAY['urgente','alta','normal','baja']::varchar[], t.prioridad), t.ultimo_mensaje_en DESC
      LIMIT 200`,
    filtro.length ? [filtro] : [],
  );
  const { rows: conteos } = await pool.query("SELECT estado, count(*)::int AS n FROM tickets GROUP BY estado");
  res.json({ success: true, data: { tickets: rows, conteos: Object.fromEntries(ESTADOS.map((e) => [e, conteos.find((c) => c.estado === e)?.n ?? 0])) } });
};

// ── GET /admin/tickets/:id ───────────────────────────────────────
export const verTicket = async (req, res) => {
  let t = await ticketPorId(req.params.id);
  if (t.estado === "abierto" && !t.asignado_a) {
    await pool.query("UPDATE tickets SET asignado_a = $2 WHERE id = $1 AND asignado_a IS NULL", [t.id, req.actor.id]);
    t = await ticketPorId(t.id);
  }
  res.json({ success: true, data: await detalleAdmin(t) });
};

// ── POST /admin/tickets/:id/mensajes { cuerpo, interno } ─────────
export const responderTicket = async (req, res) => {
  const t = await ticketPorId(req.params.id);
  const interno = req.body?.interno === true;
  let cuerpo;
  try {
    cuerpo = cuerpoValido(req.body?.cuerpo);
    if (!cuerpo || cuerpo.length < 2) throw "Escribe el mensaje.";
  } catch (e) {
    throw badRequest(e, { errores: { cuerpo: e } });
  }
  await enTransaccion(async (db) => {
    await db.query("INSERT INTO ticket_mensajes (ticket_id, autor_id, de_equipo, cuerpo, interno) VALUES ($1, $2, true, $3, $4)", [t.id, req.actor.id, cuerpo, interno]);
    if (!interno) {
      await db.query(
        `UPDATE tickets SET ultimo_mensaje_en = now(), asignado_a = COALESCE(asignado_a, $2),
                estado = CASE WHEN estado IN ('abierto', 'en_progreso') THEN 'esperando_cliente' ELSE estado END
          WHERE id = $1`,
        [t.id, req.actor.id],
      );
    }
  });
  if (!interno) {
    avisarCliente(t, { titulo: `${req.actor.name.split(" ")[0]} de Seventwo respondió`, cuerpo })
      .catch((e) => console.error("❌ Aviso de ticket:", e.message));
  }
  res.status(201).json({ success: true, message: interno ? "Nota interna guardada." : "Respuesta enviada al cliente.", data: await detalleAdmin(await ticketPorId(t.id)) });
};

// ── PATCH /admin/tickets/:id { estado?, prioridad?, asignado_a? } ─
export const actualizarTicket = async (req, res) => {
  const t = await ticketPorId(req.params.id);
  const cambios = {};
  const { estado, prioridad, asignado_a } = req.body ?? {};
  if (estado !== undefined) {
    if (!ESTADOS.includes(estado)) throw badRequest("Estado no válido.");
    cambios.estado = estado;
    cambios.cerrado_en = ["resuelto", "cerrado"].includes(estado) ? new Date() : null;
  }
  if (prioridad !== undefined) {
    if (!PRIORIDADES.includes(prioridad)) throw badRequest("Prioridad no válida.");
    cambios.prioridad = prioridad;
  }
  if (asignado_a !== undefined) {
    if (asignado_a === null) cambios.asignado_a = null;
    else {
      const { rows } = await pool.query("SELECT id FROM usuarios WHERE id = $1 AND rol IN ('admin', 'superadmin') AND NOT bloqueado", [Number(asignado_a)]);
      if (!rows[0]) throw badRequest("Solo se puede asignar a alguien del equipo.");
      cambios.asignado_a = rows[0].id;
    }
  }
  const claves = Object.keys(cambios);
  if (!claves.length) throw badRequest("No hay cambios.");
  await pool.query(`UPDATE tickets SET ${claves.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [t.id, ...claves.map((k) => cambios[k])]);
  if (cambios.estado && cambios.estado !== t.estado && ["resuelto", "cerrado"].includes(cambios.estado)) {
    await registrarActividad(pool, {
      cliente_id: t.cliente_id, actor_id: req.actor.id, entidad: "ticket", entidad_id: t.id, accion: "ticket_" + cambios.estado,
      descripcion: `Ticket ${t.codigo} ${ETIQUETA_ESTADO[cambios.estado].toLowerCase()}: ${t.asunto}`, visible_cliente: true,
    });
    avisarCliente(t, { titulo: `Ticket ${ETIQUETA_ESTADO[cambios.estado].toLowerCase()}`, cuerpo: t.asunto, email: false })
      .catch((e) => console.error("❌ Aviso de ticket:", e.message));
  }
  res.json({ success: true, message: "Ticket actualizado.", data: await detalleAdmin(await ticketPorId(t.id)) });
};
