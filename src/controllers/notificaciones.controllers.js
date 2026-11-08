// src/controllers/notificaciones.controllers.js — campana, tiempo real y Web Push.
// Todo filtra por el usuario del token (sin ids de usuario en la petición).
import { pool } from "../db.js";
import { HttpError, badRequest } from "../lib/errors.js";
import { tokenPara } from "../lib/socketCore.js";
import { VAPID_PUBLIC_KEY, pushConfigurado, socketConfigurado } from "../config.js";

// ── GET /notificaciones ─────────────────────────────────────────
export const listar = async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, tipo, titulo, cuerpo, url, datos, leida_en, created_at
       FROM notificaciones WHERE usuario_id = $1
      ORDER BY created_at DESC LIMIT 30`,
    [req.usuario.id],
  );
  const { rows: [{ n }] } = await pool.query(
    "SELECT count(*)::int AS n FROM notificaciones WHERE usuario_id = $1 AND leida_en IS NULL",
    [req.usuario.id],
  );
  res.json({ success: true, data: { notificaciones: rows, no_leidas: n } });
};

// ── POST /notificaciones/leer { ids?: number[] } (sin ids = todas) ──
export const marcarLeidas = async (req, res) => {
  // Los ids BIGSERIAL llegan como texto desde pg ("12"): se aceptan número o texto numérico.
  let ids = req.body?.ids;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.length > 100) throw badRequest("ids debe ser una lista de números.");
    ids = ids.map((v) => (typeof v === "string" && /^\d{1,18}$/.test(v) ? Number(v) : v));
    if (!ids.every((v) => Number.isSafeInteger(v) && v > 0)) throw badRequest("ids debe ser una lista de números.");
  }
  const { rowCount } = ids
    ? await pool.query(
        "UPDATE notificaciones SET leida_en = now() WHERE usuario_id = $1 AND id = ANY($2::bigint[]) AND leida_en IS NULL",
        [req.usuario.id, ids],
      )
    : await pool.query("UPDATE notificaciones SET leida_en = now() WHERE usuario_id = $1 AND leida_en IS NULL", [
        req.usuario.id,
      ]);
  res.json({ success: true, data: { marcadas: rowCount } });
};

// ── GET /notificaciones/config (qué canales en vivo hay disponibles) ──
export const config = async (req, res) => {
  res.json({
    success: true,
    data: { socket: socketConfigurado(), push: pushConfigurado(), vapidPublicKey: pushConfigurado() ? VAPID_PUBLIC_KEY : null },
  });
};

// ── POST /notificaciones/socket-token ───────────────────────────
export const socketToken = async (req, res) => {
  if (!socketConfigurado()) throw new HttpError(503, "Tiempo real no disponible.", { disponible: false });
  const { rows: [u] } = await pool.query("SELECT socket_id FROM usuarios WHERE id = $1 AND NOT bloqueado", [
    req.usuario.id,
  ]);
  if (!u) throw new HttpError(401, "Sesión no válida.");
  try {
    res.json({ success: true, data: await tokenPara(u.socket_id) });
  } catch (error) {
    console.error("❌ socket-core token:", error.message);
    throw new HttpError(502, "No se pudo conectar al tiempo real.");
  }
};

// ── POST /notificaciones/push { endpoint, keys: { p256dh, auth } } ──
export const suscribirPush = async (req, res) => {
  if (!pushConfigurado()) throw new HttpError(503, "Notificaciones push no disponibles.");
  const { endpoint, keys } = req.body ?? {};
  if (
    typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || endpoint.length > 1000 ||
    typeof keys?.p256dh !== "string" || keys.p256dh.length > 200 ||
    typeof keys?.auth !== "string" || keys.auth.length > 100
  ) {
    throw badRequest("Suscripción push no válida.");
  }
  // Un dispositivo pertenece al último usuario que lo registró.
  await pool.query(
    `INSERT INTO push_suscripciones (usuario_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET usuario_id = EXCLUDED.usuario_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent`,
    [req.usuario.id, endpoint, keys.p256dh, keys.auth, String(req.get("user-agent") || "").slice(0, 255) || null],
  );
  res.status(201).json({ success: true, message: "Notificaciones activadas en este dispositivo." });
};

// ── DELETE /notificaciones/push { endpoint } ────────────────────
export const desuscribirPush = async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== "string") throw badRequest("Falta el endpoint.");
  await pool.query("DELETE FROM push_suscripciones WHERE usuario_id = $1 AND endpoint = $2", [req.usuario.id, endpoint]);
  res.json({ success: true, message: "Notificaciones desactivadas en este dispositivo." });
};
