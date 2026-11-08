// src/emails/index.js — plantillas de email. Cada función devuelve
// { subject, html, text } listo para enviarEmail({ to, ...plantilla }).
import { FRONTEND_URL } from "../config.js";
import { bloqueCodigo, boton, escapeHtml, layout } from "./layout.js";

const hola = (name) => `<p>Hola ${escapeHtml(String(name || "").split(" ")[0] || "")},</p>`;

export const codigoVerificacion = ({ name, codigo }) => ({
  subject: `${codigo} es tu código para verificar tu correo`,
  text: `Tu código de verificación de Seventwo es ${codigo}. Vence en 15 minutos.`,
  html: layout({
    titulo: "Verifica tu correo",
    preheader: `Tu código es ${codigo}`,
    contenido: `${hola(name)}
      <p>Usa este código para verificar tu correo en Seventwo:</p>
      ${bloqueCodigo(codigo)}
      <p style="color:#71717a;font-size:13px;">Vence en 15 minutos. Si no creaste una cuenta, ignora este mensaje.</p>`,
  }),
});

export const codigoOtpLogin = ({ name, codigo }) => ({
  subject: `${codigo} es tu código de inicio de sesión`,
  text: `Tu código de inicio de sesión de Seventwo es ${codigo}. Vence en 10 minutos. Si no fuiste tú, cambia tu contraseña.`,
  html: layout({
    titulo: "Código de inicio de sesión",
    preheader: `Tu código es ${codigo}`,
    contenido: `${hola(name)}
      <p>Alguien (esperamos que tú) está iniciando sesión en tu cuenta. Tu código es:</p>
      ${bloqueCodigo(codigo)}
      <p style="color:#71717a;font-size:13px;">Vence en 10 minutos. Si no fuiste tú, tu contraseña puede estar comprometida:
      <a href="${escapeHtml(`${FRONTEND_URL}/olvide-contrasena`)}">cámbiala aquí</a>.</p>`,
  }),
});

export const cuentaBloqueada = ({ name }) => {
  const url = `${FRONTEND_URL}/olvide-contrasena`;
  return {
    subject: "Bloqueamos tu cuenta por seguridad",
    text: `Detectamos varios intentos fallidos de inicio de sesión y bloqueamos tu cuenta. Para desbloquearla restablece tu contraseña: ${url}`,
    html: layout({
      titulo: "Cuenta bloqueada",
      preheader: "Restablece tu contraseña para desbloquearla",
      contenido: `${hola(name)}
        <p>Detectamos <strong>varios intentos fallidos</strong> de inicio de sesión y bloqueamos tu cuenta para protegerla.</p>
        <p>Para desbloquearla, restablece tu contraseña:</p>
        ${boton(url, "Restablecer contraseña")}
        <p style="color:#71717a;font-size:13px;">Si fuiste tú y olvidaste la contraseña, este es el camino. Si no fuiste tú, alguien intentó acceder: elige una contraseña nueva y segura.</p>`,
    }),
  };
};
