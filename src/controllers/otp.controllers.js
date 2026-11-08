// src/controllers/otp.controllers.js — segundo factor por email (docs/AUTH.md §5.3).
//   Login:    /auth/otp/verificar · /auth/otp/reenviar           (públicas)
//   Gestión:  /auth/otp/activar[/confirmar] · /auth/otp/desactivar[/confirmar]  (Bearer)
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { HttpError, badRequest, notFound, unauthorized } from "../lib/errors.js";
import * as plantillas from "../emails/index.js";
import { hayCodigoActivo, verificarCodigo } from "../services/codigos.service.js";
import { enviarCodigo, notificar } from "../services/envio.service.js";
import { emitirSesion, usuarioPublico } from "../services/sesion.service.js";
import { normalizarEmail } from "../validations/auth.validate.js";
import { buscarPorEmail } from "./auth.controllers.js";

const usuarioActual = async (req) => {
  const { rows: [u] } = await pool.query("SELECT * FROM usuarios WHERE id = $1", [req.usuario.id]);
  if (!u) throw notFound("Usuario no encontrado.");
  return u;
};

const setOtp = async (id, activo) =>
  (await pool.query("UPDATE usuarios SET otp_activo = $2 WHERE id = $1 RETURNING *", [id, activo])).rows[0];

// ── POST /auth/otp/verificar { email, codigo } ──────────────────
// Completa el login iniciado en /auth/login (que ya validó la contraseña).
export const verificarOtpLogin = async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  const invalido = () => unauthorized("El código no es válido o expiró.");

  const usuario = await buscarPorEmail(email);
  if (!usuario || !usuario.otp_activo) throw invalido();

  const ok = await verificarCodigo({ usuarioId: usuario.id, tipo: "otp_login", codigo: req.body?.codigo });
  if (!ok) throw invalido();

  // Pudo bloquearse entre la contraseña y el código.
  if (usuario.bloqueado) {
    throw new HttpError(403, "Cuenta bloqueada por seguridad. Restablece tu contraseña para desbloquearla.", {
      codigo: "cuenta_bloqueada",
    });
  }

  res.json({ success: true, message: "Verificación correcta. ¡Bienvenido!", data: await emitirSesion(req, res, usuario) });
};

// ── POST /auth/otp/reenviar { email } ───────────────────────────
// Solo reenvía si hay un login pendiente (código vigente emitido tras una
// contraseña correcta): así nadie puede bombardear de códigos a un usuario
// solo con saber su email. Respuesta genérica.
export const reenviarOtpLogin = async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  const usuario = await buscarPorEmail(email);

  if (usuario?.otp_activo && !usuario.bloqueado && (await hayCodigoActivo(usuario.id, "otp_login"))) {
    await enviarCodigo(usuario, "otp_login", plantillas.codigoOtpLogin);
  }
  res.json({ success: true, message: "Si hay un inicio de sesión pendiente, te enviamos un código nuevo." });
};

// ── POST /auth/otp/activar (Bearer) ─────────────────────────────
// Envía un código para demostrar que el usuario recibe los correos.
export const activarOtp = async (req, res) => {
  const usuario = await usuarioActual(req);
  if (usuario.otp_activo) throw badRequest("La verificación en dos pasos ya está activa.");
  if (!usuario.email_verificado) throw badRequest("Verifica tu correo antes de activar la verificación en dos pasos.");

  await enviarCodigo(usuario, "otp_activar", plantillas.codigoOtpActivar);
  res.json({
    success: true,
    message: "Te enviamos un código para confirmar la activación.",
    data: { requiereCodigo: true },
  });
};

// ── POST /auth/otp/activar/confirmar { codigo } (Bearer) ────────
export const confirmarActivarOtp = async (req, res) => {
  const usuario = await usuarioActual(req);
  if (usuario.otp_activo) throw badRequest("La verificación en dos pasos ya está activa.");

  const ok = await verificarCodigo({ usuarioId: usuario.id, tipo: "otp_activar", codigo: req.body?.codigo });
  if (!ok) throw unauthorized("El código no es válido o expiró.");

  const actualizado = await setOtp(usuario.id, true);
  notificar(actualizado, plantillas.otpActivado);
  res.json({ success: true, message: "Verificación en dos pasos activada.", data: usuarioPublico(actualizado) });
};

// ── POST /auth/otp/desactivar { password? } (Bearer) ────────────
// Cuentas con contraseña: se confirma con la contraseña.
// Cuentas solo-Google: se envía un código (confirmar en /desactivar/confirmar).
export const desactivarOtp = async (req, res) => {
  const usuario = await usuarioActual(req);
  if (!usuario.otp_activo) throw badRequest("La verificación en dos pasos no está activa.");

  if (!usuario.password) {
    await enviarCodigo(usuario, "otp_desactivar", plantillas.codigoOtpDesactivar);
    return res.json({
      success: true,
      message: "Te enviamos un código para confirmar.",
      data: { requiereCodigo: true },
    });
  }

  const password = req.body?.password;
  if (typeof password !== "string" || !password) throw badRequest("Confirma con tu contraseña.");
  if (!(await bcrypt.compare(password, usuario.password))) throw unauthorized("Contraseña incorrecta.");

  const actualizado = await setOtp(usuario.id, false);
  notificar(actualizado, plantillas.otpDesactivado);
  res.json({ success: true, message: "Verificación en dos pasos desactivada.", data: usuarioPublico(actualizado) });
};

// ── POST /auth/otp/desactivar/confirmar { codigo } (Bearer) ─────
export const confirmarDesactivarOtp = async (req, res) => {
  const usuario = await usuarioActual(req);
  if (!usuario.otp_activo) throw badRequest("La verificación en dos pasos no está activa.");

  const ok = await verificarCodigo({ usuarioId: usuario.id, tipo: "otp_desactivar", codigo: req.body?.codigo });
  if (!ok) throw unauthorized("El código no es válido o expiró.");

  const actualizado = await setOtp(usuario.id, false);
  notificar(actualizado, plantillas.otpDesactivado);
  res.json({ success: true, message: "Verificación en dos pasos desactivada.", data: usuarioPublico(actualizado) });
};
