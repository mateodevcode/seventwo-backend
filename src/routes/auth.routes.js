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

router.post("/auth/refresh", limSesion, refresh);
router.post("/auth/logout", limSesion, logout);
router.post("/auth/logout-todo", limSesion, verificarToken, logoutTodo);
router.get("/auth/me", verificarToken, me);

export default router;
