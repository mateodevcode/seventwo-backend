// src/routes/admin.routes.js — panel de administración (admin y superadmin).
import { Router } from "express";
import {
  cambiarBloqueo,
  cambiarRol,
  listarUsuarios,
  resumen,
  verUsuario,
} from "../controllers/admin.controllers.js";
import { requiereRol, verificarToken } from "../middleware/auth.middleware.js";
import { rateLimit } from "../middleware/rateLimit.middleware.js";
import { ROLES_ADMIN } from "../lib/roles.js";

const router = Router();
const soloEquipo = [verificarToken, requiereRol(ROLES_ADMIN)];
const limAdmin = rateLimit({ nombre: "admin", max: 120, ventanaSeg: 60, clave: (req) => req.usuario?.id });

router.get("/admin/resumen", ...soloEquipo, limAdmin, resumen);
router.get("/admin/usuarios", ...soloEquipo, limAdmin, listarUsuarios);
router.get("/admin/usuarios/:id", ...soloEquipo, limAdmin, verUsuario);
router.patch("/admin/usuarios/:id/rol", ...soloEquipo, limAdmin, cambiarRol);
router.patch("/admin/usuarios/:id/bloqueo", ...soloEquipo, limAdmin, cambiarBloqueo);

export default router;
