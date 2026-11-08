// src/routes/clientes.routes.js — ficha de cliente, proyectos y catálogo (F1 de docs/CLIENTES.md).
import { Router } from "express";
import * as cliente from "../controllers/clientes.controllers.js";
import * as admin from "../controllers/admin.clientes.controllers.js";
import { requiereRol, verificarToken } from "../middleware/auth.middleware.js";
import { rateLimit } from "../middleware/rateLimit.middleware.js";
import { ROLES, ROLES_ADMIN } from "../lib/roles.js";

const router = Router();
const porUsuario = (req) => req.usuario?.id;

// Lo del propio cliente: cualquier cuenta activa (requiereRol relee la BD y
// rechaza cuentas bloqueadas). Sin ficha, las rutas devuelven vacío o 404.
const cuenta = [verificarToken, requiereRol(ROLES)];
const limCliente = rateLimit({ nombre: "cliente", max: 60, ventanaSeg: 60, clave: porUsuario });
router.get("/clientes/yo", ...cuenta, limCliente, cliente.miFicha);
router.patch(
  "/clientes/yo",
  ...cuenta,
  rateLimit({ nombre: "cliente-editar", max: 20, ventanaSeg: 3600, clave: porUsuario }),
  cliente.editarMiFicha,
);
router.get("/clientes/yo/resumen", ...cuenta, limCliente, cliente.miResumen);
router.get("/proyectos/mios", ...cuenta, limCliente, cliente.misProyectos);
router.get("/proyectos/mios/:codigo", ...cuenta, limCliente, cliente.verMiProyecto);

// Panel del equipo.
const soloEquipo = [verificarToken, requiereRol(ROLES_ADMIN)];
const limAdmin = rateLimit({ nombre: "admin-clientes", max: 120, ventanaSeg: 60, clave: porUsuario });
router.get("/admin/clientes", ...soloEquipo, limAdmin, admin.listarClientes);
router.post("/admin/clientes", ...soloEquipo, limAdmin, admin.crearCliente);
router.get("/admin/clientes/:id", ...soloEquipo, limAdmin, admin.verCliente);
router.patch("/admin/clientes/:id", ...soloEquipo, limAdmin, admin.editarCliente);

router.get("/admin/servicios", ...soloEquipo, limAdmin, admin.listarServicios);
router.post("/admin/servicios", ...soloEquipo, limAdmin, admin.crearServicio);
router.patch("/admin/servicios/:id", ...soloEquipo, limAdmin, admin.editarServicio);
router.delete("/admin/servicios/:id", ...soloEquipo, limAdmin, admin.eliminarServicio);

router.post("/admin/proyectos", ...soloEquipo, limAdmin, admin.crearProyectoAdmin);
router.get("/admin/proyectos/:id", ...soloEquipo, limAdmin, admin.verProyecto);
router.patch("/admin/proyectos/:id", ...soloEquipo, limAdmin, admin.editarProyecto);

router.post("/admin/solicitudes/:id/convertir", ...soloEquipo, limAdmin, admin.convertirSolicitud);

export default router;
