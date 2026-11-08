// src/controllers/clientes.controllers.js — lo que ve y edita el propio cliente.
// Todo se resuelve desde la cuenta del token (req.actor): nunca por un id del cliente.
import { pool, enTransaccion } from "../db.js";
import { notFound } from "../lib/errors.js";
import {
  ETIQUETA_CAMPO,
  PROYECTO_ACTIVO,
  actividadDe,
  actualizarCliente,
  clienteDeUsuario,
  detalleProyecto,
  diferencias,
  fichaPublica,
  registrarActividad,
  validarFicha,
} from "../services/clientes.service.js";

// ── GET /clientes/yo ─────────────────────────────────────────────
// data: null si la cuenta aún no tiene ficha de cliente (rol usuario).
export const miFicha = async (req, res) => {
  res.json({ success: true, data: fichaPublica(await clienteDeUsuario(req.actor.id)) });
};

// ── PATCH /clientes/yo ───────────────────────────────────────────
export const editarMiFicha = async (req, res) => {
  const cliente = await clienteDeUsuario(req.actor.id);
  if (!cliente) throw notFound("Tu cuenta aún no tiene ficha de cliente.");
  const cambios = validarFicha(req.body, { parcial: true });
  const diff = diferencias(cliente, cambios);
  const claves = Object.keys(diff);
  if (!claves.length) return res.json({ success: true, message: "Sin cambios.", data: fichaPublica(cliente) });

  const nuevo = await enTransaccion(async (db) => {
    const fila = await actualizarCliente(db, cliente.id, Object.fromEntries(claves.map((k) => [k, cambios[k]])));
    await registrarActividad(db, {
      cliente_id: cliente.id, actor_id: req.actor.id, entidad: "cliente", entidad_id: cliente.id,
      accion: "ficha_editada",
      descripcion: `Actualizaste tus datos: ${claves.map((k) => ETIQUETA_CAMPO[k] ?? k).join(", ")}`,
      datos: diff, visible_cliente: true,
    });
    return fila;
  });
  res.json({ success: true, message: "Datos de facturación actualizados.", data: fichaPublica(nuevo) });
};

// ── GET /clientes/yo/resumen ─────────────────────────────────────
export const miResumen = async (req, res) => {
  const cliente = await clienteDeUsuario(req.actor.id);
  const { rows: [{ n: solicitudesAbiertas }] } = await pool.query(
    "SELECT count(*)::int AS n FROM solicitudes WHERE usuario_id = $1 AND estado IN ('nueva', 'en_revision', 'respondida')",
    [req.actor.id],
  );
  if (!cliente) {
    return res.json({ success: true, data: { cliente: null, proyectos: [], conteos: { proyectos_activos: 0, solicitudes_abiertas: solicitudesAbiertas }, actividad: [] } });
  }

  const { rows: proyectos } = await pool.query(
    `SELECT p.codigo, p.nombre, p.tipo_proyecto, p.estado, p.progreso, p.modelo_cobro,
            p.fecha_inicio, p.fecha_entrega_estimada,
            h.nombre AS siguiente_hito, h.fecha_prevista AS siguiente_hito_fecha
       FROM proyectos p
       LEFT JOIN LATERAL (
         SELECT nombre, fecha_prevista FROM proyecto_hitos
          WHERE proyecto_id = p.id AND estado <> 'completado'
          ORDER BY orden, id LIMIT 1
       ) h ON true
      WHERE p.cliente_id = $1 AND p.estado = ANY($2)
      ORDER BY p.created_at DESC`,
    [cliente.id, PROYECTO_ACTIVO],
  );
  const { rows: [{ n: total }] } = await pool.query(
    "SELECT count(*)::int AS n FROM proyectos WHERE cliente_id = $1",
    [cliente.id],
  );

  res.json({
    success: true,
    data: {
      cliente: { nombre: cliente.nombre, estado: cliente.estado, desde: cliente.created_at },
      proyectos,
      conteos: { proyectos_activos: proyectos.length, proyectos: total, solicitudes_abiertas: solicitudesAbiertas },
      actividad: await actividadDe(cliente.id, { soloCliente: true, limite: 8 }),
    },
  });
};

// ── GET /proyectos/mios ──────────────────────────────────────────
export const misProyectos = async (req, res) => {
  const cliente = await clienteDeUsuario(req.actor.id);
  if (!cliente) return res.json({ success: true, data: [] });
  const { rows } = await pool.query(
    `SELECT p.codigo, p.nombre, p.tipo_proyecto, p.estado, p.progreso, p.modelo_cobro,
            p.valor_total, p.importe_periodo, p.periodicidad, p.moneda,
            p.fecha_inicio, p.fecha_entrega_estimada, p.created_at,
            (SELECT count(*)::int FROM proyecto_hitos WHERE proyecto_id = p.id) AS hitos,
            (SELECT count(*)::int FROM proyecto_hitos WHERE proyecto_id = p.id AND estado = 'completado') AS hitos_completados
       FROM proyectos p WHERE p.cliente_id = $1
      ORDER BY (p.estado = ANY($2)) DESC, p.created_at DESC`,
    [cliente.id, PROYECTO_ACTIVO],
  );
  res.json({ success: true, data: rows });
};

// ── GET /proyectos/mios/:codigo ──────────────────────────────────
export const verMiProyecto = async (req, res) => {
  const cliente = await clienteDeUsuario(req.actor.id);
  const codigo = String(req.params.codigo ?? "").toUpperCase().slice(0, 12);
  const { rows: [p] } = cliente
    ? await pool.query("SELECT id FROM proyectos WHERE codigo = $1 AND cliente_id = $2", [codigo, cliente.id])
    : { rows: [] };
  if (!p) throw notFound("Proyecto no encontrado.");
  res.json({ success: true, data: await detalleProyecto(pool, p.id, { paraCliente: true }) });
};
