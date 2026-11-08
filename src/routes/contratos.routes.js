// src/routes/contratos.routes.js — contratos de proyecto (F2 de docs/CLIENTES.md).
import express, { Router } from "express";
import * as ctrl from "../controllers/contratos.controllers.js";
import { requiereRol, verificarToken } from "../middleware/auth.middleware.js";
import { rateLimit } from "../middleware/rateLimit.middleware.js";
import { ROLES, ROLES_ADMIN } from "../lib/roles.js";

const router = Router();
const porUsuario = (req) => req.usuario?.id;
const soloEquipo = [verificarToken, requiereRol(ROLES_ADMIN)];
const cuenta = [verificarToken, requiereRol(ROLES)];

// El PDF llega crudo (application/pdf); el tamaño lo limita express (10 MB) y nginx (11 MB).
const pdfCrudo = express.raw({ type: "application/pdf", limit: "10mb" });

router.post(
  "/admin/proyectos/:id/contratos",
  ...soloEquipo,
  rateLimit({ nombre: "contrato-subir", max: 30, ventanaSeg: 3600, clave: porUsuario }),
  pdfCrudo,
  ctrl.subirContrato,
);
const limAdmin = rateLimit({ nombre: "admin-contratos", max: 120, ventanaSeg: 60, clave: porUsuario });
router.post("/admin/contratos/:id/enviar", ...soloEquipo, limAdmin, ctrl.enviarContrato);
router.delete("/admin/contratos/:id", ...soloEquipo, limAdmin, ctrl.borrarBorrador);
router.get("/admin/contratos/:id/archivo", ...soloEquipo, limAdmin, ctrl.archivoAdmin);

const limCliente = rateLimit({ nombre: "contratos", max: 60, ventanaSeg: 60, clave: porUsuario });
router.get("/contratos/:id/archivo", ...cuenta, limCliente, ctrl.archivoCliente);
router.post(
  "/contratos/:id/aceptar",
  ...cuenta,
  rateLimit({ nombre: "contrato-aceptar", max: 10, ventanaSeg: 3600, clave: porUsuario }),
  ctrl.aceptarContrato,
);

export default router;
