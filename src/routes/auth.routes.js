// src/routes/auth.routes.js — límites según docs/AUTH.md §7.
import { Router } from "express";
import {
  login,
  logout,
  logoutTodo,
  me,
  refresh,
  reenviarVerificacion,
  registro,
  verificarEmail,
} from "../controllers/auth.controllers.js";
import {
  activarOtp,
  confirmarActivarOtp,
  confirmarDesactivarOtp,
  desactivarOtp,
  reenviarOtpLogin,
  verificarOtpLogin,
} from "../controllers/otp.controllers.js";
import {
  cambiarPassword,
  restablecerPassword,
  solicitarReset,
  validarCodigoReset,
} from "../controllers/password.controllers.js";
import { callbackGoogle, iniciarGoogle } from "../controllers/google.controllers.js";
import { verificarToken } from "../middleware/auth.middleware.js";
import { porEmail, rateLimit } from "../middleware/rateLimit.middleware.js";

const DIEZ_MIN = 600;
const router = Router();

const limRegistro = rateLimit({ nombre: "registro", max: 5, ventanaSeg: DIEZ_MIN });
const limVerificar = rateLimit({ nombre: "verificar", max: 10, ventanaSeg: DIEZ_MIN });
const limVerificarEmail = rateLimit({ nombre: "verificar-email", max: 10, ventanaSeg: DIEZ_MIN, clave: porEmail });
const limLoginIp = rateLimit({ nombre: "login", max: 10, ventanaSeg: DIEZ_MIN });
const limLoginEmail = rateLimit({ nombre: "login-email", max: 5, ventanaSeg: DIEZ_MIN, clave: porEmail });
const limSesion = rateLimit({ nombre: "sesion", max: 60, ventanaSeg: 60 });

router.post("/auth/registro", limRegistro, registro);
router.post("/auth/verificar-email", limVerificar, limVerificarEmail, verificarEmail);
router.post("/auth/verificar-email/reenviar", limVerificar, limVerificarEmail, reenviarVerificacion);
router.post("/auth/login", limLoginIp, limLoginEmail, login);

// Segundo factor
const limOtp = rateLimit({ nombre: "otp", max: 10, ventanaSeg: DIEZ_MIN });
const limOtpEmail = rateLimit({ nombre: "otp-email", max: 10, ventanaSeg: DIEZ_MIN, clave: porEmail });
const limOtpUsuario = rateLimit({ nombre: "otp-gestion", max: 10, ventanaSeg: DIEZ_MIN, clave: (req) => req.usuario?.id });

router.post("/auth/otp/verificar", limOtp, limOtpEmail, verificarOtpLogin);
router.post("/auth/otp/reenviar", limOtp, limOtpEmail, reenviarOtpLogin);
router.post("/auth/otp/activar", verificarToken, limOtpUsuario, activarOtp);
router.post("/auth/otp/activar/confirmar", verificarToken, limOtpUsuario, confirmarActivarOtp);
router.post("/auth/otp/desactivar", verificarToken, limOtpUsuario, desactivarOtp);
router.post("/auth/otp/desactivar/confirmar", verificarToken, limOtpUsuario, confirmarDesactivarOtp);

// Contraseña
const limReset = rateLimit({ nombre: "reset", max: 5, ventanaSeg: DIEZ_MIN });
const limResetEmail = rateLimit({ nombre: "reset-email", max: 5, ventanaSeg: DIEZ_MIN, clave: porEmail });
const limCambio = rateLimit({ nombre: "password-cambio", max: 10, ventanaSeg: DIEZ_MIN, clave: (req) => req.usuario?.id });

router.post("/auth/password/solicitar", limReset, limResetEmail, solicitarReset);
router.post("/auth/password/validar", limReset, limResetEmail, validarCodigoReset);
router.post("/auth/password/restablecer", limReset, restablecerPassword);
router.patch("/auth/password", verificarToken, limCambio, cambiarPassword);

// Google OAuth
const limGoogle = rateLimit({ nombre: "google", max: 20, ventanaSeg: 60 });
router.get("/auth/google", limGoogle, iniciarGoogle);
router.get("/auth/google/callback", limGoogle, callbackGoogle);

router.post("/auth/refresh", limSesion, refresh);
router.post("/auth/logout", limSesion, logout);
router.post("/auth/logout-todo", limSesion, verificarToken, logoutTodo);
router.get("/auth/me", verificarToken, me);

export default router;
