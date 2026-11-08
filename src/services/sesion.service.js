// src/services/sesion.service.js — access token (JWT 15 min, en memoria del
// front) + refresh token (JWT 7 días en cookie httpOnly, guardado hasheado y
// rotado en cada uso, con detección de reutilización).
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { COOKIE_DOMAIN, IS_PROD, JWT_REFRESH_SECRET, JWT_SECRET } from "../config.js";
import { sha256 } from "../lib/crypto.js";
import { unauthorized } from "../lib/errors.js";

export const COOKIE_REFRESH = "refresh_token";
const ACCESS_TTL = "15m";
const REFRESH_DIAS = 7;
// Dos peticiones de refresh casi simultáneas (dos pestañas) usan el mismo
// token: la segunda llega ya revocado. Dentro de esta ventana no se trata
// como robo y se le da una sesión nueva.
const GRACIA_REUSO_SEG = 30;

export const opcionesCookie = () => ({
  httpOnly: true,
  secure: IS_PROD,
  sameSite: "lax",
  domain: COOKIE_DOMAIN,
  path: "/",
  maxAge: REFRESH_DIAS * 24 * 60 * 60 * 1000,
});

const borrarCookie = (res) => {
  const { maxAge, ...opts } = opcionesCookie();
  res.clearCookie(COOKIE_REFRESH, opts);
};

// Datos del usuario que se pueden enviar al front.
export const usuarioPublico = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  telefono: u.telefono ?? null,
  rol: u.rol,
  provider: u.provider,
  image_url: u.image_url ?? null,
  email_verificado: !!u.email_verificado,
  otp_activo: !!u.otp_activo,
  tiene_password: u.password !== undefined ? !!u.password : undefined,
});

export const generarAccessToken = (u) =>
  jwt.sign({ id: u.id, email: u.email, rol: u.rol }, JWT_SECRET, { expiresIn: ACCESS_TTL });

const generarRefreshToken = (u) =>
  jwt.sign({ id: u.id, jti: crypto.randomUUID() }, JWT_REFRESH_SECRET, { expiresIn: `${REFRESH_DIAS}d` });

async function guardarRefresh(req, usuarioId, token, db = pool) {
  await db.query(
    `INSERT INTO refresh_tokens (usuario_id, token_hash, expira_en, user_agent, ip)
     VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [usuarioId, sha256(token), REFRESH_DIAS, String(req.get("user-agent") || "").slice(0, 255) || null, req.ip || null],
  );
}

/**
 * Crea la sesión completa: guarda el refresh, pone la cookie y marca el login.
 * @returns {{ usuario: object, accessToken: string }}
 */
export async function emitirSesion(req, res, usuario) {
  const refreshToken = generarRefreshToken(usuario);
  await guardarRefresh(req, usuario.id, refreshToken);
  await pool.query(
    "UPDATE usuarios SET intentos_fallidos = 0, ultimo_login = now() WHERE id = $1",
    [usuario.id],
  );
  // Solicitudes de presupuesto hechas sin sesión con este email → a su cuenta.
  // Solo con email verificado (docs/PRESUPUESTOS.md §2.2).
  if (usuario.email_verificado) {
    await pool.query(
      "UPDATE solicitudes SET usuario_id = $1 WHERE email = $2 AND usuario_id IS NULL",
      [usuario.id, usuario.email],
    );
  }
  res.cookie(COOKIE_REFRESH, refreshToken, opcionesCookie());
  return { usuario: usuarioPublico(usuario), accessToken: generarAccessToken(usuario) };
}

/** Valida y rota el refresh de la cookie. Lanza 401 si no es válido. */
export async function rotarRefresh(req, res) {
  const token = req.cookies?.[COOKIE_REFRESH];
  const fallar = (msg = "Sesión no válida. Inicia sesión de nuevo.") => {
    borrarCookie(res);
    return unauthorized(msg);
  };
  if (!token) throw fallar("No hay sesión activa.");

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_REFRESH_SECRET);
  } catch {
    throw fallar("Sesión expirada. Inicia sesión de nuevo.");
  }

  const hash = sha256(token);
  // Revocación atómica: solo una petición puede "ganar" la rotación.
  const { rows: ganadas } = await pool.query(
    `UPDATE refresh_tokens SET revocado = true, revocado_en = now(), revocado_motivo = 'rotacion'
      WHERE token_hash = $1 AND revocado = false AND expira_en > now()
      RETURNING usuario_id`,
    [hash],
  );

  if (!ganadas.length) {
    const { rows } = await pool.query(
      `SELECT usuario_id, revocado, revocado_motivo,
              revocado_en > now() - make_interval(secs => $2) AS en_gracia
         FROM refresh_tokens WHERE token_hash = $1`,
      [hash, GRACIA_REUSO_SEG],
    );
    const previo = rows[0];
    if (!previo || !previo.revocado) throw fallar();
    // Logout o revocación masiva: definitivo, sin gracia.
    if (previo.revocado_motivo !== "rotacion") throw fallar();
    if (!previo.en_gracia) {
      // Reutilización de un token ya rotado: posible robo → cerrar todo.
      await revocarTodas(previo.usuario_id);
      console.warn(`⚠️  Reutilización de refresh token del usuario ${previo.usuario_id}: sesiones revocadas.`);
      throw fallar();
    }
    // Refresh concurrente dentro de la ventana de gracia: se sigue adelante.
  }

  const { rows: urows } = await pool.query("SELECT * FROM usuarios WHERE id = $1", [decoded.id]);
  const usuario = urows[0];
  if (!usuario || usuario.bloqueado) {
    if (usuario) await revocarTodas(usuario.id);
    throw fallar(usuario ? "Cuenta bloqueada. Restablece tu contraseña para desbloquearla." : undefined);
  }

  const nuevo = generarRefreshToken(usuario);
  await guardarRefresh(req, usuario.id, nuevo);
  res.cookie(COOKIE_REFRESH, nuevo, opcionesCookie());
  return { usuario: usuarioPublico(usuario), accessToken: generarAccessToken(usuario) };
}

/** Revoca el refresh de la cookie actual (logout) y borra la cookie. */
export async function cerrarSesion(req, res) {
  const token = req.cookies?.[COOKIE_REFRESH];
  if (token) {
    await pool.query(
      `UPDATE refresh_tokens SET revocado = true, revocado_en = now(), revocado_motivo = 'logout'
        WHERE token_hash = $1 AND revocado = false`,
      [sha256(token)],
    );
  }
  borrarCookie(res);
}

/** Revoca todas las sesiones de un usuario. */
export async function revocarTodas(usuarioId, db = pool) {
  await db.query(
    `UPDATE refresh_tokens SET revocado = true, revocado_en = now(), revocado_motivo = 'revocacion'
      WHERE usuario_id = $1 AND (revocado = false OR revocado_motivo = 'rotacion')`,
    [usuarioId],
  );
}

export { borrarCookie };
