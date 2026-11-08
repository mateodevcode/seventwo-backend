// src/middleware/auth.middleware.js
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config.js";
import { pool } from "../db.js";

const leerBearer = (req) => {
  const [tipo, token] = String(req.headers.authorization || "").split(" ");
  return tipo === "Bearer" && token ? token : null;
};

// Exige un access token válido. Deja el payload en req.usuario = { id, email, rol }.
export const verificarToken = (req, res, next) => {
  const token = leerBearer(req);
  if (!token) {
    return res.status(401).json({ success: false, error: "Acceso denegado. Token requerido." });
  }
  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    const expirado = error.name === "TokenExpiredError";
    // 401 en ambos casos: el front intenta /auth/refresh y, si falla, manda a /login.
    return res.status(401).json({
      success: false,
      error: expirado ? "Token expirado." : "Token inválido.",
      data: { codigo: expirado ? "token_expirado" : "token_invalido" },
    });
  }
};

// Si hay token válido rellena req.usuario; si no, sigue como anónimo.
export const verificarTokenOpcional = (req, res, next) => {
  const token = leerBearer(req);
  if (token) {
    try {
      req.usuario = jwt.verify(token, JWT_SECRET);
    } catch {
      /* anónimo */
    }
  }
  next();
};

// Exige un rol leyendo el usuario ACTUAL de la BD (no el rol del token, que
// puede tener hasta 15 min). Deja el usuario en req.actor. Va tras verificarToken.
// Uso: router.get("/admin/x", verificarToken, requiereRol(ROLES_ADMIN), ctrl)
export const requiereRol = (rolesPermitidos) => async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, email, rol, bloqueado FROM usuarios WHERE id = $1",
      [req.usuario?.id],
    );
    const actor = rows[0];
    if (!actor || actor.bloqueado) {
      return res.status(401).json({ success: false, error: "Sesión no válida." });
    }
    if (!rolesPermitidos.includes(actor.rol)) {
      return res.status(403).json({ success: false, error: "No tienes permisos para esta acción." });
    }
    req.actor = actor;
    next();
  } catch (error) {
    next(error);
  }
};

// Variante rápida con el rol del token (sin consulta). Preferir requiereRol
// en rutas sensibles.
export const verificarRol = (rolesPermitidos) => (req, res, next) => {
  if (!req.usuario) {
    return res.status(401).json({ success: false, error: "No autenticado." });
  }
  if (!rolesPermitidos.includes(req.usuario.rol)) {
    return res.status(403).json({ success: false, error: "No tienes permisos para esta acción." });
  }
  next();
};
