// src/emails/contratos.js — plantillas de contratos.
import { boton, escapeHtml, layout } from "./layout.js";

const hola = (name) => `<p>Hola ${escapeHtml(String(name || "").split(" ")[0])},</p>`;

/** Al cliente: hay un contrato para leer y aceptar. */
export const contratoEnviado = ({ name, codigo, proyecto, titulo, version, nota, urlCta, textoCta }) => ({
  subject: `Contrato de ${codigo} listo para revisar`,
  text: `Tienes el contrato «${titulo}» (v${version}) del proyecto ${codigo} · ${proyecto} listo para leer y aceptar.${nota ? `\n\n${nota}` : ""}\n\n${textoCta}: ${urlCta}`,
  html: layout({
    titulo: `Contrato de ${codigo}`,
    preheader: `${titulo} · versión ${version}`,
    contenido: `${hola(name)}
      <p>Ya puedes leer el contrato <strong>${escapeHtml(titulo)}</strong> (versión ${version}) de tu proyecto <strong>${escapeHtml(proyecto)}</strong> (${escapeHtml(codigo)}).</p>
      ${nota ? `<div style="margin:16px 0;padding:14px 16px;background:#f4f4f5;border-left:3px solid #00a49c;white-space:pre-wrap;">${escapeHtml(nota)}</div>` : ""}
      <p>Desde tu área de cliente puedes abrirlo y aceptarlo. Si tienes dudas, responde a este email antes de aceptarlo.</p>
      ${boton(urlCta, textoCta)}`,
  }),
});

/** Al buzón del equipo: el cliente aceptó. */
export const contratoAceptado = ({ cliente, codigo, proyecto, titulo, version, nombre, fecha, ip, url }) => ({
  subject: `${cliente} aceptó el contrato de ${codigo}`,
  text: `${cliente} aceptó «${titulo}» v${version} (${codigo} · ${proyecto}) el ${fecha}. Firmó como «${nombre}» desde ${ip}. ${url}`,
  html: layout({
    titulo: `Contrato aceptado · ${codigo}`,
    preheader: `${cliente} · v${version}`,
    contenido: `<p><strong>${escapeHtml(cliente)}</strong> aceptó el contrato <strong>${escapeHtml(titulo)}</strong> (versión ${version}) del proyecto ${escapeHtml(codigo)} · ${escapeHtml(proyecto)}.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.8;">
        <tr><td style="color:#71717a;padding-right:14px;">Firmó como</td><td>${escapeHtml(nombre)}</td></tr>
        <tr><td style="color:#71717a;padding-right:14px;">Fecha</td><td>${escapeHtml(fecha)}</td></tr>
        <tr><td style="color:#71717a;padding-right:14px;">IP</td><td>${escapeHtml(ip)}</td></tr>
      </table>
      ${boton(url, "Abrir el proyecto")}`,
  }),
});
