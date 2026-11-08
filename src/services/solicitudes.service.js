// src/services/solicitudes.service.js — reglas compartidas del flujo de presupuestos.
import { pool } from "../db.js";
import { EQUIPO_EMAIL, FRONTEND_URL } from "../config.js";
import * as plantillas from "../emails/solicitudes.js";
import { escapeTg } from "../lib/telegram.js";
import { equipo, notificarEnSegundoPlano } from "./notificaciones.service.js";

export const TIPOS_PROYECTO = ["Página web", "Aplicación web", "App móvil", "Software a medida"];
export const RANGOS_PRESUPUESTO = ["Por definir", "Menos de $10M COP", "Más de $10M COP"];
export const ESTADOS = Object.keys(plantillas.ESTADOS);

// Rutas del front (relativas para la campana; absolutas para emails/Telegram).
export const rutaAdmin = (id) => `/admin?solicitud=${id}`;
export const rutaCliente = (codigo) => `/area-cliente?seccion=cotizar&solicitud=${encodeURIComponent(codigo)}`;
const abs = (ruta) => `${FRONTEND_URL}${ruta}`;
const urlRegistro = (email, codigo) =>
  abs(`/registro?email=${encodeURIComponent(email)}&next=${encodeURIComponent(rutaCliente(codigo))}`);

// La vinculación por email (solicitudes hechas sin sesión → cuenta) ocurre en
// sesion.service.emitirSesion, solo con el email verificado.

/** Datos del solicitante con cuenta (para avisos in-app), o null. */
export async function cuentaDe(solicitud) {
  if (!solicitud.usuario_id) return null;
  const { rows } = await pool.query(
    "SELECT id, socket_id, name FROM usuarios WHERE id = $1 AND NOT bloqueado",
    [solicitud.usuario_id],
  );
  return rows[0] ?? null;
}

// ── Avisos ──────────────────────────────────────────────────────

export async function avisarSolicitudNueva(s) {
  const extracto = s.descripcion.length > 160 ? `${s.descripcion.slice(0, 157)}…` : s.descripcion;
  const tg = [
    `🆕 <b>Nueva solicitud ${escapeTg(s.codigo)}</b>`,
    `👤 ${escapeTg(s.nombre)} — ${escapeTg(s.email)}`,
    s.telefono && `📞 ${escapeTg(s.telefono)}`,
    `🧩 ${escapeTg(s.tipo_proyecto)} · 💰 ${escapeTg(s.presupuesto || "Sin indicar")}`,
    `📝 <i>${escapeTg(extracto)}</i>`,
  ].filter(Boolean).join("\n");

  notificarEnSegundoPlano({
    usuarios: await equipo(),
    tipo: "solicitud_nueva",
    titulo: `Nueva solicitud ${s.codigo}`,
    cuerpo: `${s.nombre} · ${s.tipo_proyecto}`,
    url: rutaAdmin(s.id),
    datos: { solicitud_id: s.id, codigo: s.codigo },
    email: {
      to: EQUIPO_EMAIL,
      replyTo: s.email,
      ...plantillas.solicitudNuevaEquipo({
        codigo: s.codigo, nombre: s.nombre, email: s.email, telefono: s.telefono, empresa: s.empresa,
        tipo: s.tipo_proyecto, presupuesto: s.presupuesto, descripcion: s.descripcion, url: abs(rutaAdmin(s.id)),
      }),
    },
    telegram: { html: tg, boton: { texto: "Abrir en el panel", url: abs(rutaAdmin(s.id)) } },
  });

  // Confirmación al solicitante (+ in-app si ya tiene cuenta).
  const cuenta = await cuentaDe(s);
  const cta = cuenta
    ? { urlCta: abs(rutaCliente(s.codigo)), textoCta: "Ver mi solicitud" }
    : { urlCta: urlRegistro(s.email, s.codigo), textoCta: "Crea tu cuenta para seguirla" };
  notificarEnSegundoPlano({
    usuarios: cuenta ? [cuenta] : [],
    tipo: "solicitud_recibida",
    titulo: `Recibimos tu solicitud ${s.codigo}`,
    cuerpo: "Te responderemos en menos de 24 h hábiles.",
    url: rutaCliente(s.codigo),
    datos: { codigo: s.codigo },
    email: {
      to: s.email,
      replyTo: EQUIPO_EMAIL,
      ...plantillas.solicitudConfirmacion({ name: s.nombre, codigo: s.codigo, tipo: s.tipo_proyecto, ...cta }),
    },
  });
}

export async function avisarRespuestaEquipo(s, { cuerpo, autor }) {
  const cuenta = await cuentaDe(s);
  const cta = cuenta
    ? { urlCta: abs(rutaCliente(s.codigo)), textoCta: "Ver y responder" }
    : { urlCta: urlRegistro(s.email, s.codigo), textoCta: "Crea tu cuenta para responder" };
  notificarEnSegundoPlano({
    usuarios: cuenta ? [cuenta] : [],
    tipo: "solicitud_respondida",
    titulo: `Respuesta a tu solicitud ${s.codigo}`,
    cuerpo: cuerpo.length > 140 ? `${cuerpo.slice(0, 137)}…` : cuerpo,
    url: rutaCliente(s.codigo),
    datos: { codigo: s.codigo },
    email: {
      to: s.email,
      replyTo: EQUIPO_EMAIL,
      ...plantillas.solicitudRespuesta({ name: s.nombre, codigo: s.codigo, cuerpo, autor, ...cta }),
    },
  });
}

export async function avisarClienteRespondio(s, { cuerpo, nombre }) {
  const extracto = cuerpo.length > 160 ? `${cuerpo.slice(0, 157)}…` : cuerpo;
  notificarEnSegundoPlano({
    usuarios: await equipo(),
    tipo: "solicitud_mensaje_cliente",
    titulo: `${nombre} respondió en ${s.codigo}`,
    cuerpo: extracto,
    url: rutaAdmin(s.id),
    datos: { solicitud_id: s.id, codigo: s.codigo },
    email: {
      to: EQUIPO_EMAIL,
      replyTo: s.email,
      ...plantillas.solicitudClienteRespondio({ codigo: s.codigo, nombre, cuerpo, url: abs(rutaAdmin(s.id)) }),
    },
    telegram: {
      html: `💬 <b>${escapeTg(nombre)}</b> respondió en <b>${escapeTg(s.codigo)}</b>\n<i>${escapeTg(extracto)}</i>`,
      boton: { texto: "Abrir en el panel", url: abs(rutaAdmin(s.id)) },
    },
  });
}

export async function avisarCambioEstado(s, estado) {
  const cuenta = await cuentaDe(s);
  const cta = cuenta
    ? { urlCta: abs(rutaCliente(s.codigo)), textoCta: "Ver mi solicitud" }
    : { urlCta: urlRegistro(s.email, s.codigo), textoCta: "Crea tu cuenta" };
  notificarEnSegundoPlano({
    usuarios: cuenta ? [cuenta] : [],
    tipo: "solicitud_estado",
    titulo: `Solicitud ${s.codigo}: ${plantillas.ESTADOS[estado]}`,
    url: rutaCliente(s.codigo),
    datos: { codigo: s.codigo, estado },
    email: {
      to: s.email,
      replyTo: EQUIPO_EMAIL,
      ...plantillas.solicitudEstado({ name: s.nombre, codigo: s.codigo, estado, ...cta }),
    },
  });
}
