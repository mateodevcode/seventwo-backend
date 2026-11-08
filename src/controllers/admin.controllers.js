// src/controllers/admin.controllers.js — panel /admin (admin y superadmin).
// El actor (req.actor) viene de requiereRol, leído de la BD en cada petición.
import { pool } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { ROLES, esRolValido, puedeGestionar, rolesAsignables } from "../lib/roles.js";
import { revocarTodas } from "../services/sesion.service.js";

const CAMPOS = `id, name, email, telefono, rol, provider, image_url, email_verificado,
  otp_activo, bloqueado, intentos_fallidos, ultimo_login, created_at,
  (password IS NOT NULL) AS tiene_password`;

const POR_PAGINA = 20;

// Datos del usuario + qué puede hacer el actor con él (para pintar la UI).
const conPermisos = (actor, u) => ({
  ...u,
  permisos: {
    gestionar: puedeGestionar(actor, u),
    rolesAsignables: puedeGestionar(actor, u) ? rolesAsignables(actor) : [],
  },
});

async function buscarUsuario(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw notFound("Usuario no encontrado.");
  const { rows } = await pool.query(`SELECT ${CAMPOS} FROM usuarios WHERE id = $1`, [n]);
  if (!rows[0]) throw notFound("Usuario no encontrado.");
  return rows[0];
}

// ── GET /admin/resumen ──────────────────────────────────────────
export const resumen = async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      count(*)::int                                                   AS total,
      count(*) FILTER (WHERE rol = 'usuario')::int                    AS usuarios,
      count(*) FILTER (WHERE rol = 'cliente')::int                    AS clientes,
      count(*) FILTER (WHERE rol IN ('admin', 'superadmin'))::int     AS equipo,
      count(*) FILTER (WHERE bloqueado)::int                          AS bloqueados,
      count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS nuevos_7d
    FROM usuarios`);
  res.json({ success: true, data: rows[0] });
};

// ── GET /admin/usuarios?buscar=&rol=&pagina= ────────────────────
export const listarUsuarios = async (req, res) => {
  const buscar = String(req.query.buscar ?? "").trim().slice(0, 100);
  const rol = String(req.query.rol ?? "").trim();
  const pagina = Math.max(1, Number.parseInt(req.query.pagina, 10) || 1);
  if (rol && !esRolValido(rol)) throw badRequest("Rol no válido.");

  const filtros = [];
  const valores = [];
  if (buscar) {
    valores.push(`%${buscar.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    filtros.push(`(name ILIKE $${valores.length} OR email ILIKE $${valores.length})`);
  }
  if (rol) {
    valores.push(rol);
    filtros.push(`rol = $${valores.length}`);
  }
  const where = filtros.length ? `WHERE ${filtros.join(" AND ")}` : "";

  const { rows: [{ total }] } = await pool.query(`SELECT count(*)::int AS total FROM usuarios ${where}`, valores);
  valores.push(POR_PAGINA, (pagina - 1) * POR_PAGINA);
  const { rows } = await pool.query(
    `SELECT ${CAMPOS} FROM usuarios ${where}
      ORDER BY array_position(ARRAY['superadmin','admin','cliente','usuario']::varchar[], rol), created_at DESC
      LIMIT $${valores.length - 1} OFFSET $${valores.length}`,
    valores,
  );

  res.json({
    success: true,
    data: {
      usuarios: rows.map((u) => conPermisos(req.actor, u)),
      total,
      pagina,
      paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
      roles: ROLES,
      actor: { id: req.actor.id, rol: req.actor.rol, rolesAsignables: rolesAsignables(req.actor) },
    },
  });
};

// ── GET /admin/usuarios/:id ─────────────────────────────────────
export const verUsuario = async (req, res) => {
  const u = await buscarUsuario(req.params.id);
  res.json({ success: true, data: conPermisos(req.actor, u) });
};

// ── PATCH /admin/usuarios/:id/rol { rol } ───────────────────────
export const cambiarRol = async (req, res) => {
  const nuevo = String(req.body?.rol ?? "");
  const objetivo = await buscarUsuario(req.params.id);

  if (!puedeGestionar(req.actor, objetivo)) throw forbidden("No puedes cambiar el rol de esta cuenta.");
  if (!rolesAsignables(req.actor).includes(nuevo)) throw forbidden("No puedes asignar ese rol.");
  if (objetivo.rol === nuevo) return res.json({ success: true, message: "Sin cambios.", data: conPermisos(req.actor, objetivo) });

  const { rows: [u] } = await pool.query(
    `UPDATE usuarios SET rol = $2 WHERE id = $1 RETURNING ${CAMPOS}`,
    [objetivo.id, nuevo],
  );
  // Quitarle el rol de admin corta su acceso de inmediato (su token tenía rol admin).
  if (objetivo.rol === "admin") await revocarTodas(objetivo.id);

  console.log(`👤 Rol: ${req.actor.email} cambió ${objetivo.email} de ${objetivo.rol} a ${nuevo}`);
  res.json({ success: true, message: `Rol actualizado a ${nuevo}.`, data: conPermisos(req.actor, u) });
};

// ── PATCH /admin/usuarios/:id/bloqueo { bloqueado } ─────────────
export const cambiarBloqueo = async (req, res) => {
  const bloqueado = req.body?.bloqueado;
  if (typeof bloqueado !== "boolean") throw badRequest("Indica bloqueado: true o false.");
  const objetivo = await buscarUsuario(req.params.id);
  if (!puedeGestionar(req.actor, objetivo)) throw forbidden("No puedes bloquear o desbloquear esta cuenta.");

  const { rows: [u] } = await pool.query(
    `UPDATE usuarios
        SET bloqueado = $2,
            intentos_fallidos = CASE WHEN $2 THEN intentos_fallidos ELSE 0 END
      WHERE id = $1 RETURNING ${CAMPOS}`,
    [objetivo.id, bloqueado],
  );
  if (bloqueado) await revocarTodas(objetivo.id);

  console.log(`🔒 ${req.actor.email} ${bloqueado ? "bloqueó" : "desbloqueó"} a ${objetivo.email}`);
  res.json({
    success: true,
    message: bloqueado ? "Cuenta bloqueada y sesiones cerradas." : "Cuenta desbloqueada.",
    data: conPermisos(req.actor, u),
  });
};
