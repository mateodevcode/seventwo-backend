// src/emails/layout.js — plantilla base de los emails de Seventwo.
// HTML con tablas y estilos inline para compatibilidad con clientes de correo.

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function layout({ titulo, contenido, preheader = "" }) {
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(titulo)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0a0a0a;padding:20px 32px;color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:1px;">SEVENTWO</td></tr>
        <tr><td style="padding:32px;font-size:15px;line-height:1.6;">${contenido}</td></tr>
        <tr><td style="padding:16px 32px 28px;font-size:12px;color:#71717a;border-top:1px solid #e4e4e7;">
          Este es un mensaje automático de Seventwo Technologies. Si no fuiste tú, puedes ignorarlo o escribirnos.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Bloque destacado con un código de 6 dígitos.
export const bloqueCodigo = (codigo) =>
  `<div style="margin:24px 0;text-align:center;">
     <span style="display:inline-block;padding:14px 24px;background:#f4f4f5;border-radius:8px;font-size:32px;font-weight:bold;letter-spacing:8px;font-family:'Courier New',monospace;">${escapeHtml(codigo)}</span>
   </div>`;

export const boton = (url, texto) =>
  `<p style="text-align:center;margin:24px 0;">
     <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;background:#0a0a0a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">${escapeHtml(texto)}</a>
   </p>`;
