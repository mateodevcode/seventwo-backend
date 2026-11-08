// src/controllers/auth.controllers.js — registro, verificación de email,
// login y sesión (docs/AUTH.md §5.1, §5.2, §5.6).
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { HttpError, badRequest, conflict, notFound, unauthorized } from "../lib/errors.js";
import { enviarEmail } from "../lib/mailer.js";
import * as plantillas from "../emails/index.js";
import {
  cooldownRestante,
  emitirCodigo,
  invalidarCodigos,
  verificarCodigo,
} from "../services/codigos.service.js";
import {
  cerrarSesion,
  emitirSesion,
  revocarTodas,
  rotarRefresh,
  usuarioPublico,
} from "../services/sesion.service.js";
import { emailValido, normalizarEmail, validarRegistro } from "../validations/auth.validate.js";

const BCRYPT_COSTE = 12;
const MAX_INTENTOS_PASSWORD = 5;
// Hash válido de una contraseña aleatoria: se compara contra él cuando el
// usuario no existe, para que el tiempo de respuesta no delate si el email está.
const HASH_FALSO = bcrypt.hashSync("seventwo-hash-de-relleno-no-usar", BCRYPT_COSTE);

const buscarPorEmail = async (email) =>
  (await pool.query("SELECT * FROM usuarios WHERE email = $1", [email])).rows[0];

// Emite un código y lo envía. Si el email falla invalida el código y lanza 502.
async function enviarCodigo(usuario, tipo, plantilla, opciones = {}) {
  const codigo = await emitirCodigo({ usuarioId: usuario.id, tipo, ...opciones });
  try {
    await enviarEmail({ to: usuario.email, ...plantilla({ name: usuario.name, codigo }) });
  } catch (error) {
    console.error(`❌ No se pudo enviar el email (${tipo}) a ${usuario.email}:`, error.message);
    await invalidarCodigos(usuario.id, tipo);
    throw new HttpError(502, "No pudimos enviar el código. Intenta de nuevo en unos minutos.");
  }
}

// ── POST /auth/registro ─────────────────────────────────────────
export const registro = async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  const { name, password, telefono } = req.body ?? {};

  const errores = validarRegistro({ name, email, password });
  if (errores.length) throw badRequest(errores[0], { errores });

  if (await buscarPorEmail(email)) throw conflict("Ya existe una cuenta con ese email.");

  const hash = await bcrypt.hash(password, BCRYPT_COSTE);
  let usuario;
  try {
    ({ rows: [usuario] } = await pool.query(
      `INSERT INTO usuarios (name, email, password, telefono, provider)
       VALUES ($1, $2, $3, $4, 'local') RETURNING *`,
      [name.trim(), email, hash, typeof telefono === "string" ? telefono.trim().slice(0, 20) || null : null],
    ));
  } catch (error) {
    if (error.code === "23505") throw conflict("Ya existe una cuenta con ese email."); // carrera
    throw error;
  }

  let emailEnviado = true;
  try {
    await enviarCodigo(usuario, "verificar_email", plantillas.codigoVerificacion);
  } catch {
    emailEnviado = false; // la cuenta existe: el usuario puede pedir reenvío
  }

  res.status(201).json({
    success: true,
    message: emailEnviado
      ? "Cuenta creada. Te enviamos un código para verificar tu correo."
      : "Cuenta creada, pero no pudimos enviar el código. Pide que te lo reenviemos.",
    data: { requiereVerificacion: true, email, emailEnviado },
  });
};

// ── POST /auth/verificar-email { email, codigo } ────────────────
export const verificarEmail = async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  const invalido = () => unauthorized("El código no es válido o expiró.");

  const usuario = await buscarPorEmail(email);
  if (!usuario) throw invalido();
  if (usuario.email_verificado) throw badRequest("Este correo ya está verificado. Inicia sesión.");

  const ok = await verificarCodigo({ usuarioId: usuario.id, tipo: "verificar_email", codigo: req.body?.codigo });
  if (!ok) throw invalido();

  const { rows: [actualizado] } = await pool.query(
    "UPDATE usuarios SET email_verificado = true WHERE id = $1 RETURNING *",
    [usuario.id],
  );
  if (actualizado.bloqueado) {
    throw new HttpError(403, "Correo verificado, pero la cuenta está bloqueada. Restablece tu contraseña.");
  }

  res.json({ success: true, message: "Correo verificado. ¡Bienvenido!", data: await emitirSesion(req, res, actualizado) });
};

// ── POST /auth/verificar-email/reenviar { email } ───────────────
// Respuesta genérica: no revela si el email existe.
export const reenviarVerificacion = async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  if (!emailValido(email)) throw badRequest("El email no es válido.");

  const usuario = await buscarPorEmail(email);
  if (usuario && !usuario.email_verificado) {
    await enviarCodigo(usuario, "verificar_email", plantillas.codigoVerificacion);
  }
  res.json({ success: true, message: "Si hay una verificación pendiente, te enviamos un código nuevo." });
};

// ── POST /auth/login { email, password } ────────────────────────
export const login = async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  const password = req.body?.password;
  if (!email || typeof password !== "string" || !password) {
    throw badRequest("Email y contraseña son requeridos.");
  }

  const usuario = await buscarPorEmail(email);
  const credencialesMal = () => unauthorized("Credenciales incorrectas.");

  if (!usuario) {
    await bcrypt.compare(password, HASH_FALSO);
    throw credencialesMal();
  }
  if (!usuario.password) {
    await bcrypt.compare(password, HASH_FALSO);
    throw new HttpError(401, "Esta cuenta usa ingreso con Google.", { codigo: "usa_google" });
  }

  const passwordOk = await bcrypt.compare(password, usuario.password);

  if (!passwordOk) {
    if (!usuario.bloqueado) {
      const { rows: [u] } = await pool.query(
        `UPDATE usuarios
            SET intentos_fallidos = intentos_fallidos + 1,
                bloqueado = intentos_fallidos + 1 >= $2
          WHERE id = $1 RETURNING bloqueado`,
        [usuario.id, MAX_INTENTOS_PASSWORD],
      );
      if (u.bloqueado) {
        await revocarTodas(usuario.id);
        enviarEmail({ to: usuario.email, ...plantillas.cuentaBloqueada({ name: usuario.name }) }).catch((e) =>
          console.error("❌ Email de cuenta bloqueada no enviado:", e.message),
        );
      }
    }
    throw credencialesMal();
  }

  // Solo se revela el bloqueo a quien conoce la contraseña.
  if (usuario.bloqueado) {
    throw new HttpError(403, "Cuenta bloqueada por seguridad. Restablece tu contraseña para desbloquearla.", {
      codigo: "cuenta_bloqueada",
    });
  }

  if (usuario.intentos_fallidos) {
    await pool.query("UPDATE usuarios SET intentos_fallidos = 0 WHERE id = $1", [usuario.id]);
  }

  if (!usuario.email_verificado) {
    // Reenvía el código si ya pasó el cooldown; si no, sirve el anterior.
    if ((await cooldownRestante(usuario.id, "verificar_email")) === 0) {
      await enviarCodigo(usuario, "verificar_email", plantillas.codigoVerificacion);
    }
    return res.json({
      success: true,
      message: "Debes verificar tu correo. Te enviamos un código.",
      data: { requiereVerificacion: true, email },
    });
  }

  if (usuario.otp_activo) {
    await enviarCodigo(usuario, "otp_login", plantillas.codigoOtpLogin, { ignorarCooldown: true });
    return res.json({
      success: true,
      message: "Te enviamos un código de verificación a tu correo.",
      data: { requiereOTP: true, email },
    });
  }

  res.json({ success: true, message: "Login correcto.", data: await emitirSesion(req, res, usuario) });
};

// ── POST /auth/refresh (cookie) ─────────────────────────────────
export const refresh = async (req, res) => {
  res.json({ success: true, data: await rotarRefresh(req, res) });
};

// ── POST /auth/logout (cookie) ──────────────────────────────────
export const logout = async (req, res) => {
  await cerrarSesion(req, res);
  res.json({ success: true, message: "Sesión cerrada." });
};

// ── POST /auth/logout-todo (access token) ───────────────────────
export const logoutTodo = async (req, res) => {
  await revocarTodas(req.usuario.id);
  await cerrarSesion(req, res);
  res.json({ success: true, message: "Cerraste sesión en todos tus dispositivos." });
};

// ── GET /auth/me (access token) ─────────────────────────────────
export const me = async (req, res) => {
  const { rows: [usuario] } = await pool.query("SELECT * FROM usuarios WHERE id = $1", [req.usuario.id]);
  if (!usuario) throw notFound("Usuario no encontrado.");
  res.json({ success: true, data: usuarioPublico(usuario) });
};
