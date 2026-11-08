// src/controllers/password.controllers.js — restablecer (sin sesión) y cambiar
// (con sesión) la contraseña (docs/AUTH.md §5.5 y §5.6).
//
//   1. POST /auth/password/solicitar   { email }              → código por email (respuesta genérica)
//   2. POST /auth/password/validar     { email, codigo }      → { resetToken } de un solo uso, 10 min
//   3. POST /auth/password/restablecer { resetToken, password } → nueva contraseña, desbloquea, cierra sesiones
//      PATCH /auth/password            { actual, nueva } (Bearer)
import bcrypt from "bcryptjs";
import { enTransaccion, pool } from "../db.js";
import { badRequest, notFound, unauthorized } from "../lib/errors.js";
import * as plantillas from "../emails/index.js";
import {
  consumirToken,
  cooldownRestante,
  emitirCodigo,
  invalidarCodigos,
  verificarCodigo,
} from "../services/codigos.service.js";
import { enviarCodigo, notificar } from "../services/envio.service.js";
import { emitirSesion, revocarTodas } from "../services/sesion.service.js";
import { emailValido, normalizarEmail, validarPassword } from "../validations/auth.validate.js";
import { buscarPorEmail } from "./auth.controllers.js";

const BCRYPT_COSTE = 12;
const GENERICO = "Si el correo está registrado, te enviamos un código para restablecer tu contraseña.";

// ── 1. POST /auth/password/solicitar { email } ──────────────────
// Nunca revela si el email existe: ni el cooldown ni un fallo de envío
// cambian la respuesta (solo se registran en el log).
export const solicitarReset = async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  if (!emailValido(email)) throw badRequest("El email no es válido.");

  const usuario = await buscarPorEmail(email);
  if (usuario && (await cooldownRestante(usuario.id, "reset_password")) === 0) {
    try {
      await enviarCodigo(usuario, "reset_password", plantillas.codigoResetPassword);
    } catch (error) {
      console.error(`❌ Reset de contraseña: no se envió el código a ${email}:`, error.message);
    }
  }
  res.json({ success: true, message: GENERICO });
};

// ── 2. POST /auth/password/validar { email, codigo } ────────────
export const validarCodigoReset = async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  const invalido = () => unauthorized("El código no es válido o expiró.");

  const usuario = await buscarPorEmail(email);
  if (!usuario) throw invalido();

  const ok = await verificarCodigo({ usuarioId: usuario.id, tipo: "reset_password", codigo: req.body?.codigo });
  if (!ok) throw invalido();

  const resetToken = await emitirCodigo({ usuarioId: usuario.id, tipo: "reset_token", ignorarCooldown: true });
  res.json({
    success: true,
    message: "Código verificado. Elige tu nueva contraseña.",
    data: { resetToken, expiraEnSeg: 600 },
  });
};

// ── 3. POST /auth/password/restablecer { resetToken, password } ─
export const restablecerPassword = async (req, res) => {
  const { resetToken, password } = req.body ?? {};

  // Se valida antes de consumir el token: una contraseña débil no lo gasta.
  const errPass = validarPassword(password);
  if (errPass) throw badRequest(errPass);

  const hash = await bcrypt.hash(password, BCRYPT_COSTE);

  const usuario = await enTransaccion(async (db) => {
    const token = await consumirToken({ tipo: "reset_token", token: resetToken }, db);
    if (!token) return null;
    const { rows: [u] } = await db.query(
      `UPDATE usuarios
          SET password = $2, intentos_fallidos = 0, bloqueado = false, email_verificado = true
        WHERE id = $1 RETURNING *`,
      [token.usuarioId, hash],
    );
    await revocarTodas(token.usuarioId, db);
    await invalidarCodigos(token.usuarioId, "reset_password", db);
    return u;
  });
  if (!usuario) throw unauthorized("El enlace para restablecer expiró. Solicita un código nuevo.");

  notificar(usuario, plantillas.passwordCambiada);
  res.json({ success: true, message: "Contraseña restablecida. Ya puedes iniciar sesión." });
};

// ── PATCH /auth/password { actual, nueva } (Bearer) ─────────────
// Cierra las demás sesiones y devuelve una sesión nueva para este dispositivo.
export const cambiarPassword = async (req, res) => {
  const { actual, nueva } = req.body ?? {};
  const { rows: [usuario] } = await pool.query("SELECT * FROM usuarios WHERE id = $1", [req.usuario.id]);
  if (!usuario) throw notFound("Usuario no encontrado.");

  if (!usuario.password) {
    throw badRequest("Tu cuenta usa Google y no tiene contraseña. Créala con «¿Olvidaste tu contraseña?».");
  }
  if (typeof actual !== "string" || !(await bcrypt.compare(actual, usuario.password))) {
    throw unauthorized("La contraseña actual no es correcta.");
  }
  const errPass = validarPassword(nueva);
  if (errPass) throw badRequest(errPass);
  if (await bcrypt.compare(nueva, usuario.password)) {
    throw badRequest("La nueva contraseña debe ser distinta de la actual.");
  }

  const hash = await bcrypt.hash(nueva, BCRYPT_COSTE);
  await enTransaccion(async (db) => {
    await db.query("UPDATE usuarios SET password = $2 WHERE id = $1", [usuario.id, hash]);
    await revocarTodas(usuario.id, db);
  });

  notificar(usuario, plantillas.passwordCambiada);
  res.json({
    success: true,
    message: "Contraseña actualizada. Cerramos tus otras sesiones.",
    data: await emitirSesion(req, res, usuario),
  });
};
