// src/routes/tickets.routes.js — soporte por tickets (F5 de docs/CLIENTES.md).
import { Router } from "express";
import * as ctrl from "../controllers/tickets.controllers.js";
import { requiereRol, verificarToken } from "../middleware/auth.middleware.js";
import { rateLimit } from "../middleware/rateLimit.middleware.js";
import { ROLES, ROLES_ADMIN } from "../lib/roles.js";

const router = Router();
const porUsuario = (req) => req.usuario?.id;
const cuenta = [verificarToken, requiereRol(ROLES)];
const soloEquipo = [verificarToken, requiereRol(ROLES_ADMIN)];

const limCliente = rateLimit({ nombre: "tickets", max: 60, ventanaSeg: 60, clave: porUsuario });
router.get("/tickets/mios", ...cuenta, limCliente, ctrl.misTickets);
router.get("/tickets/mios/:codigo", ...cuenta, limCliente, ctrl.verMiTicket);
router.post("/tickets/mios", ...cuenta, rateLimit({ nombre: "ticket-crear", max: 10, ventanaSeg: 3600, clave: porUsuario }), ctrl.crearTicket);
router.post("/tickets/mios/:codigo/mensajes", ...cuenta, rateLimit({ nombre: "ticket-mensaje", max: 30, ventanaSeg: 3600, clave: porUsuario }), ctrl.responderMiTicket);

const limAdmin = rateLimit({ nombre: "admin-tickets", max: 120, ventanaSeg: 60, clave: porUsuario });
router.get("/admin/tickets", ...soloEquipo, limAdmin, ctrl.listarTickets);
router.get("/admin/tickets/:id", ...soloEquipo, limAdmin, ctrl.verTicket);
router.post("/admin/tickets/:id/mensajes", ...soloEquipo, limAdmin, ctrl.responderTicket);
router.patch("/admin/tickets/:id", ...soloEquipo, limAdmin, ctrl.actualizarTicket);

export default router;
