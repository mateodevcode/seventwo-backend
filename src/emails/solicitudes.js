// src/emails/solicitudes.js — plantillas del flujo de presupuestos.
import { boton, escapeHtml, layout } from "./layout.js";

const hola = (name) => `<p>Hola ${escapeHtml(String(name || "").split(" ")[0])},</p>`;
const parrafos = (texto) =>
  escapeHtml(texto)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
const cita = (texto) =>
  `<div style="margin:16px 0;padding:14px 16px;background:#f4f4f5;border-left:3px solid #00a49c;">${parrafos(texto)}</div>`;

export const ESTADOS = {
  nueva: "Nueva",
  en_revision: "En revisión",
  respondida: "Respondida",
  aceptada: "Aceptada",
  rechazada: "Rechazada",
  archivada: "Archivada",
};

/** Al solicitante, nada más enviar. */
export const solicitudConfirmacion = ({ name, codigo, tipo, urlCta, textoCta }) => ({
  subject: `Recibimos tu solicitud ${codigo}`,
  text: `Recibimos tu solicitud ${codigo} (${tipo}). Te responderemos a este correo en menos de 24 h hábiles. ${textoCta}: ${urlCta}`,
  html: layout({
    titulo: `Solicitud ${codigo}`,
    preheader: "Te responderemos en menos de 24 h hábiles",
    contenido: `${hola(name)}
      <p>Recibimos tu solicitud de presupuesto <strong>${escapeHtml(codigo)}</strong> para <strong>${escapeHtml(tipo)}</strong>.</p>
      <p>Nuestro equipo la revisará y te responderá a este correo en menos de <strong>24 horas hábiles</strong>.</p>
      ${boton(urlCta, textoCta)}
      <p style="color:#71717a;font-size:13px;">Puedes responder a este email si quieres añadir algo.</p>`,
  }),
});

/** Al buzón del equipo. */
export const solicitudNuevaEquipo = ({ codigo, nombre, email, telefono, empresa, tipo, presupuesto, descripcion, url }) => ({
  subject: `Nueva solicitud ${codigo} · ${tipo}`,
  text: `Nueva solicitud ${codigo} de ${nombre} <${email}> · ${tipo} · ${presupuesto || "sin rango"}\n\n${descripcion}\n\n${url}`,
  html: layout({
    titulo: `Nueva solicitud ${codigo}`,
    preheader: `${nombre} · ${tipo}`,
    contenido: `<p><strong>Nueva solicitud de presupuesto ${escapeHtml(codigo)}</strong></p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.8;">
        <tr><td style="color:#71717a;padding-right:14px;">Nombre</td><td>${escapeHtml(nombre)}</td></tr>
        <tr><td style="color:#71717a;padding-right:14px;">Email</td><td>${escapeHtml(email)}</td></tr>
        ${telefono ? `<tr><td style="color:#71717a;padding-right:14px;">Teléfono</td><td>${escapeHtml(telefono)}</td></tr>` : ""}
        ${empresa ? `<tr><td style="color:#71717a;padding-right:14px;">Empresa</td><td>${escapeHtml(empresa)}</td></tr>` : ""}
        <tr><td style="color:#71717a;padding-right:14px;">Proyecto</td><td>${escapeHtml(tipo)}</td></tr>
        <tr><td style="color:#71717a;padding-right:14px;">Presupuesto</td><td>${escapeHtml(presupuesto || "Sin indicar")}</td></tr>
      </table>
      ${cita(descripcion)}
      ${boton(url, "Abrir en el panel")}`,
  }),
});

/** Al solicitante cuando el equipo responde. */
export const solicitudRespuesta = ({ name, codigo, cuerpo, autor, urlCta, textoCta }) => ({
  subject: `Seventwo respondió a tu solicitud ${codigo}`,
  text: `${autor} respondió a tu solicitud ${codigo}:\n\n${cuerpo}\n\n${textoCta}: ${urlCta}`,
  html: layout({
    titulo: `Respuesta a ${codigo}`,
    preheader: `${autor} respondió a tu solicitud`,
    contenido: `${hola(name)}
      <p><strong>${escapeHtml(autor)}</strong> respondió a tu solicitud <strong>${escapeHtml(codigo)}</strong>:</p>
      ${cita(cuerpo)}
      ${boton(urlCta, textoCta)}
      <p style="color:#71717a;font-size:13px;">También puedes contestar directamente a este email.</p>`,
  }),
});

/** Al buzón del equipo cuando el cliente contesta desde su área. */
export const solicitudClienteRespondio = ({ codigo, nombre, cuerpo, url }) => ({
  subject: `${nombre} respondió en ${codigo}`,
  text: `${nombre} respondió en ${codigo}:\n\n${cuerpo}\n\n${url}`,
  html: layout({
    titulo: `Respuesta en ${codigo}`,
    preheader: `${nombre} respondió`,
    contenido: `<p><strong>${escapeHtml(nombre)}</strong> respondió en la solicitud <strong>${escapeHtml(codigo)}</strong>:</p>
      ${cita(cuerpo)}
      ${boton(url, "Abrir en el panel")}`,
  }),
});

/** Al solicitante cuando la solicitud se acepta o se rechaza. */
export const solicitudEstado = ({ name, codigo, estado, urlCta, textoCta }) => ({
  subject: `Tu solicitud ${codigo}: ${ESTADOS[estado]}`,
  text: `Tu solicitud ${codigo} cambió a: ${ESTADOS[estado]}. ${textoCta}: ${urlCta}`,
  html: layout({
    titulo: `Solicitud ${codigo}`,
    preheader: ESTADOS[estado],
    contenido: `${hola(name)}
      <p>Tu solicitud <strong>${escapeHtml(codigo)}</strong> ahora está <strong>${escapeHtml(ESTADOS[estado])}</strong>.</p>
      ${estado === "aceptada" ? "<p>¡Gracias por confiar en Seventwo! Nos pondremos en contacto contigo para los siguientes pasos.</p>" : ""}
      ${boton(urlCta, textoCta)}`,
  }),
});
