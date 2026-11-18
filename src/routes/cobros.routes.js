// src/routes/cobros.routes.js — cobros, pagos y comprobantes (F3 de docs/CLIENTES.md).
import express, { Router } from "express";
import * as ctrl from "../controllers/cobros.controllers.js";
import { requiereRol, verificarToken } from "../middleware/auth.middleware.js";
import { rateLimit } from "../middleware/rateLimit.middleware.js";
import { ROLES, ROLES_ADMIN } from "../lib/roles.js";

const router = Router();
const porUsuario = (req) => req.usuario?.id;
const soloEquipo = [verificarToken, requiereRol(ROLES_ADMIN)];
const cuenta = [verificarToken, requiereRol(ROLES)];

// Comprobante crudo: imagen o PDF (el tipo real se valida por la cabecera del archivo).
const comprobante = express.raw({ type: ["image/jpeg", "image/png", "image/webp", "application/pdf"], limit: "5mb" });

const limAdmin = rateLimit({ nombre: "admin-cobros", max: 120, ventanaSeg: 60, clave: porUsuario });
router.get("/admin/cobros", ...soloEquipo, limAdmin, ctrl.panelPagos);
router.post("/admin/proyectos/:id/cobros", ...soloEquipo, limAdmin, ctrl.crearCobro);
router.post("/admin/proyectos/:id/cobros/generar", ...soloEquipo, limAdmin, ctrl.generarAhora);
router.post("/admin/cobros/pagar-lote", ...soloEquipo, limAdmin, ctrl.pagarLote);
router.post("/admin/cobros/:id/anular", ...soloEquipo, limAdmin, ctrl.anularCobro);
router.post("/admin/cobros/:id/pagos", ...soloEquipo, limAdmin, ctrl.registrarPago);
router.post("/admin/pagos/:id/confirmar", ...soloEquipo, limAdmin, ctrl.confirmarPago);
router.post("/admin/pagos/:id/rechazar", ...soloEquipo, limAdmin, ctrl.rechazarPago);
router.post("/admin/pagos/:id/comprobante", ...soloEquipo, limAdmin, comprobante, ctrl.adjuntarComprobanteEquipo);
router.get("/admin/pagos/:id/comprobante", ...soloEquipo, limAdmin, ctrl.verComprobanteEquipo);

const limCliente = rateLimit({ nombre: "cobros", max: 60, ventanaSeg: 60, clave: porUsuario });
const limSubida = rateLimit({ nombre: "comprobante-subir", max: 20, ventanaSeg: 3600, clave: porUsuario });
router.get("/cobros/mios", ...cuenta, limCliente, ctrl.misCobros);
router.post("/cobros/mios/:codigo/comprobante", ...cuenta, limSubida, comprobante, ctrl.subirComprobanteCobro);
router.post("/pagos/:id/comprobante", ...cuenta, limSubida, comprobante, ctrl.adjuntarComprobanteCliente);
router.get("/pagos/:id/comprobante", ...cuenta, limCliente, ctrl.verComprobanteCliente);
router.post(
  "/cobros/mios/:codigo/mercadopago",
  ...cuenta,
  rateLimit({ nombre: "mp-preferencia", max: 20, ventanaSeg: 3600, clave: porUsuario }),
  ctrl.pagarConMercadoPago,
);

// Webhook público de Mercado Pago (firma HMAC verificada en el controlador).
router.post("/webhooks/mercadopago", rateLimit({ nombre: "mp-webhook", max: 300, ventanaSeg: 60 }), ctrl.webhookMercadoPago);

export default router;
