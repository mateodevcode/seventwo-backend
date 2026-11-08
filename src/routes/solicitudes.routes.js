// src/routes/solicitudes.routes.js — presupuestos (público, cliente y admin) y notificaciones.
import { Router } from "express";
import * as publico from "../controllers/solicitudes.controllers.js";
import * as admin from "../controllers/admin.solicitudes.controllers.js";
import * as notif from "../controllers/notificaciones.controllers.js";
import { requiereRol, verificarToken, verificarTokenOpcional } from "../middleware/auth.middleware.js";
import { porEmail, rateLimit } from "../middleware/rateLimit.middleware.js";
import { ROLES_ADMIN } from "../lib/roles.js";

const router = Router();
const HORA = 3600;
const porUsuario = (req) => req.usuario?.id;

// Formulario público: 5/hora por IP y 3/día por email.
router.post(
  "/solicitudes",
  verificarTokenOpcional,
  rateLimit({ nombre: "solicitud-ip", max: 5, ventanaSeg: HORA }),
  rateLimit({ nombre: "solicitud-email", max: 3, ventanaSeg: 24 * HORA, clave: porEmail }),
  publico.crearSolicitud,
);

// Mis solicitudes (cualquier cuenta).
const limMias = rateLimit({ nombre: "solicitudes-mias", max: 60, ventanaSeg: 60, clave: porUsuario });
router.get("/solicitudes/mias", verificarToken, limMias, publico.misSolicitudes);
router.get("/solicitudes/mias/:codigo", verificarToken, limMias, publico.verMiSolicitud);
router.post(
  "/solicitudes/mias/:codigo/mensajes",
  verificarToken,
  rateLimit({ nombre: "solicitud-mensaje", max: 20, ventanaSeg: HORA, clave: porUsuario }),
  publico.responderMiSolicitud,
);

// Panel del equipo.
const soloEquipo = [verificarToken, requiereRol(ROLES_ADMIN)];
const limAdmin = rateLimit({ nombre: "admin-solicitudes", max: 120, ventanaSeg: 60, clave: porUsuario });
router.get("/admin/solicitudes", ...soloEquipo, limAdmin, admin.listar);
router.get("/admin/solicitudes/:id", ...soloEquipo, limAdmin, admin.ver);
router.post("/admin/solicitudes/:id/mensajes", ...soloEquipo, limAdmin, admin.responder);
router.patch("/admin/solicitudes/:id", ...soloEquipo, limAdmin, admin.actualizar);

// Notificaciones.
const limNotif = rateLimit({ nombre: "notificaciones", max: 120, ventanaSeg: 60, clave: porUsuario });
router.get("/notificaciones", verificarToken, limNotif, notif.listar);
router.get("/notificaciones/config", verificarToken, limNotif, notif.config);
router.post("/notificaciones/leer", verificarToken, limNotif, notif.marcarLeidas);
router.post(
  "/notificaciones/socket-token",
  verificarToken,
  rateLimit({ nombre: "socket-token", max: 30, ventanaSeg: 60, clave: porUsuario }),
  notif.socketToken,
);
router.post("/notificaciones/push", verificarToken, limNotif, notif.suscribirPush);
router.delete("/notificaciones/push", verificarToken, limNotif, notif.desuscribirPush);

export default router;
