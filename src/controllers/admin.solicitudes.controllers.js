// src/controllers/admin.solicitudes.controllers.js — /admin/solicitudes (admin y superadmin).
import { pool } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import {
  ESTADOS,
  avisarCambioEstado,
  avisarRespuestaEquipo,
} from "../services/solicitudes.service.js";

const POR_PAGINA = 20;

async function buscar(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw notFound("Solicitud no encontrada.");
  const { rows } = await pool.query("SELECT * FROM solicitudes WHERE id = $1", [n]);
  if (!rows[0]) throw notFound("Solicitud no encontrada.");
  return rows[0];
}

// ── GET /admin/solicitudes?estado=&buscar=&pagina= ──────────────
export const listar = async (req, res) => {
  const estado = String(req.query.estado ?? "").trim();
  const texto = String(req.query.buscar ?? "").trim().slice(0, 100);
  const pagina = Math.max(1, Number.parseInt(req.query.pagina, 10) || 1);
  if (estado && !ESTADOS.includes(estado)) throw badRequest("Estado no válido.");

  const filtros = [];
  const valores = [];
  if (estado) {
    valores.push(estado);
    filtros.push(`s.estado = $${valores.length}`);
  } else {
    filtros.push("s.estado <> 'archivada'");
  }
  if (texto) {
    valores.push(`%${texto.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    filtros.push(`(s.nombre ILIKE $${valores.length} OR s.email ILIKE $${valores.length} OR s.codigo ILIKE $${valores.length} OR s.empresa ILIKE $${valores.length})`);
  }
  const where = `WHERE ${filtros.join(" AND ")}`;

  const { rows: [{ total }] } = await pool.query(`SELECT count(*)::int AS total FROM solicitudes s ${where}`, valores);
  valores.push(POR_PAGINA, (pagina - 1) * POR_PAGINA);
  const { rows } = await pool.query(
    `SELECT s.id, s.codigo, s.nombre, s.email, s.empresa, s.tipo_proyecto, s.presupuesto, s.estado,
            s.origen, s.created_at, s.updated_at, s.usuario_id,
            u.rol AS usuario_rol, a.name AS asignado
       FROM solicitudes s
       LEFT JOIN usuarios u ON u.id = s.usuario_id
       LEFT JOIN usuarios a ON a.id = s.asignado_a
       ${where}
      ORDER BY (s.estado = 'nueva') DESC, s.created_at DESC
      LIMIT $${valores.length - 1} OFFSET $${valores.length}`,
    valores,
  );
  const { rows: conteos } = await pool.query("SELECT estado, count(*)::int AS n FROM solicitudes GROUP BY estado");

  res.json({
    success: true,
    data: {
      solicitudes: rows,
      total,
      pagina,
      paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
      conteos: Object.fromEntries(ESTADOS.map((e) => [e, conteos.find((c) => c.estado === e)?.n ?? 0])),
    },
  });
};

async function detalle(s) {
  const { rows: mensajes } = await pool.query(
    `SELECT m.id, m.cuerpo, m.de_equipo, m.interno, m.created_at, u.name AS autor
       FROM solicitud_mensajes m LEFT JOIN usuarios u ON u.id = m.autor_id
      WHERE m.solicitud_id = $1 ORDER BY m.created_at`,
    [s.id],
  );
  const { rows: [cuenta] } = s.usuario_id
    ? await pool.query("SELECT id, name, email, rol, bloqueado FROM usuarios WHERE id = $1", [s.usuario_id])
    : { rows: [null] };
  const { rows: equipo } = await pool.query(
    "SELECT id, name FROM usuarios WHERE rol IN ('admin', 'superadmin') AND NOT bloqueado ORDER BY name",
  );
  // ¿Ya es un proyecto? (botón "Convertir en proyecto" o enlace al proyecto)
  const { rows: [proyecto] } = await pool.query(
    "SELECT id, codigo, cliente_id FROM proyectos WHERE solicitud_id = $1",
    [s.id],
  );
  const { ip, user_agent, ...publica } = s;
  return { ...publica, cuenta, mensajes, equipo, proyecto: proyecto ?? null };
}

// ── GET /admin/solicitudes/:id ──────────────────────────────────
// Abrir una solicitud nueva la pasa a "en revisión".
export const ver = async (req, res) => {
  let s = await buscar(req.params.id);
  if (s.estado === "nueva") {
    const { rows } = await pool.query(
      "UPDATE solicitudes SET estado = 'en_revision', asignado_a = COALESCE(asignado_a, $2) WHERE id = $1 RETURNING *",
      [s.id, req.actor.id],
    );
    s = rows[0];
  }
  res.json({ success: true, data: await detalle(s) });
};

// ── POST /admin/solicitudes/:id/mensajes { cuerpo, interno } ────
export const responder = async (req, res) => {
  const s = await buscar(req.params.id);
  const cuerpo = typeof req.body?.cuerpo === "string" ? req.body.cuerpo.trim().slice(0, 5000) : "";
  const interno = req.body?.interno === true;
  if (cuerpo.length < 2) throw badRequest("Escribe el mensaje.");

  await pool.query(
    "INSERT INTO solicitud_mensajes (solicitud_id, autor_id, de_equipo, cuerpo, interno) VALUES ($1, $2, true, $3, $4)",
    [s.id, req.actor.id, cuerpo, interno],
  );

  let actual = s;
  if (!interno) {
    const { rows } = await pool.query(
      `UPDATE solicitudes
          SET estado = CASE WHEN estado IN ('nueva', 'en_revision') THEN 'respondida' ELSE estado END,
              asignado_a = COALESCE(asignado_a, $2)
        WHERE id = $1 RETURNING *`,
      [s.id, req.actor.id],
    );
    actual = rows[0];
    avisarRespuestaEquipo(actual, { cuerpo, autor: `${req.actor.name.split(" ")[0]} de Seventwo` }).catch((e) =>
      console.error("❌ Avisos de respuesta del equipo:", e.message),
    );
  }
  res.status(201).json({
    success: true,
    message: interno ? "Nota interna guardada." : "Respuesta enviada al cliente.",
    data: await detalle(actual),
  });
};

// ── PATCH /admin/solicitudes/:id { estado?, asignado_a? } ───────
export const actualizar = async (req, res) => {
  const s = await buscar(req.params.id);
  const { estado, asignado_a } = req.body ?? {};
  const cambios = {};

  if (estado !== undefined) {
    if (!ESTADOS.includes(estado)) throw badRequest("Estado no válido.");
    cambios.estado = estado;
  }
  if (asignado_a !== undefined) {
    if (asignado_a === null) cambios.asignado_a = null;
    else {
      const { rows } = await pool.query(
        "SELECT id FROM usuarios WHERE id = $1 AND rol IN ('admin', 'superadmin') AND NOT bloqueado",
        [Number(asignado_a)],
      );
      if (!rows[0]) throw badRequest("Solo se puede asignar a alguien del equipo.");
      cambios.asignado_a = rows[0].id;
    }
  }
  const claves = Object.keys(cambios);
  if (!claves.length) throw badRequest("No hay cambios.");

  const { rows: [actual] } = await pool.query(
    `UPDATE solicitudes SET ${claves.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
    [s.id, ...claves.map((k) => cambios[k])],
  );
  if (cambios.estado && cambios.estado !== s.estado && ["aceptada", "rechazada"].includes(cambios.estado)) {
    avisarCambioEstado(actual, cambios.estado).catch((e) => console.error("❌ Aviso de cambio de estado:", e.message));
  }
  res.json({ success: true, message: "Solicitud actualizada.", data: await detalle(actual) });
};
