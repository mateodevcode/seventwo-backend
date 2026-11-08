// src/emails/clientes.js — plantillas de clientes y proyectos.
import { boton, escapeHtml, layout } from "./layout.js";

const hola = (name) => `<p>Hola ${escapeHtml(String(name || "").split(" ")[0])},</p>`;

/** Al cliente cuando se crea su proyecto. */
export const proyectoCreado = ({ name, codigo, nombre, urlCta, textoCta }) => ({
  subject: `Tu proyecto ${codigo} ya está en marcha`,
  text: `Creamos tu proyecto ${codigo} (${nombre}) en Seventwo. Desde tu área de cliente puedes seguir su estado, hitos y fechas. ${textoCta}: ${urlCta}`,
  html: layout({
    titulo: `Proyecto ${codigo}`,
    preheader: nombre,
    contenido: `${hola(name)}
      <p>Ya creamos tu proyecto <strong>${escapeHtml(nombre)}</strong> (<strong>${escapeHtml(codigo)}</strong>) en Seventwo.</p>
      <p>Desde tu área de cliente puedes seguir su estado, los hitos y las fechas, y mantener tus datos de facturación al día.</p>
      ${boton(urlCta, textoCta)}
      <p style="color:#71717a;font-size:13px;">Si tienes cualquier duda, responde a este email.</p>`,
  }),
});
