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

export const codigoOtpActivar = ({ name, codigo }) => ({
  subject: `${codigo} es tu código para activar la verificación en dos pasos`,
  text: `Tu código para activar la verificación en dos pasos de Seventwo es ${codigo}. Vence en 10 minutos.`,
  html: layout({
    titulo: "Activar verificación en dos pasos",
    preheader: `Tu código es ${codigo}`,
    contenido: `${hola(name)}
      <p>Para activar la <strong>verificación en dos pasos</strong> confirma que recibes nuestros correos con este código:</p>
      ${bloqueCodigo(codigo)}
      <p style="color:#71717a;font-size:13px;">Vence en 10 minutos. Si no lo pediste tú, ignora este mensaje.</p>`,
  }),
});

export const codigoOtpDesactivar = ({ name, codigo }) => ({
  subject: `${codigo} es tu código para desactivar la verificación en dos pasos`,
  text: `Tu código para desactivar la verificación en dos pasos de Seventwo es ${codigo}. Vence en 10 minutos. Si no fuiste tú, no lo compartas.`,
  html: layout({
    titulo: "Desactivar verificación en dos pasos",
    preheader: `Tu código es ${codigo}`,
    contenido: `${hola(name)}
      <p>Recibimos una solicitud para <strong>desactivar</strong> la verificación en dos pasos de tu cuenta. Tu código es:</p>
      ${bloqueCodigo(codigo)}
      <p style="color:#71717a;font-size:13px;">Vence en 10 minutos. Si no fuiste tú, no compartas este código con nadie.</p>`,
  }),
});

export const otpActivado = ({ name }) => ({
  subject: "Activaste la verificación en dos pasos",
  text: "Desde ahora te pediremos un código por email cada vez que inicies sesión en Seventwo.",
  html: layout({
    titulo: "Verificación en dos pasos activada",
    contenido: `${hola(name)}
      <p>Activaste la <strong>verificación en dos pasos</strong>. Desde ahora te enviaremos un código a este correo cada vez que inicies sesión.</p>
      <p style="color:#71717a;font-size:13px;">Si no fuiste tú, cambia tu contraseña de inmediato:
      <a href="${escapeHtml(`${FRONTEND_URL}/olvide-contrasena`)}">restablecer contraseña</a>.</p>`,
  }),
});

export const otpDesactivado = ({ name }) => ({
  subject: "Desactivaste la verificación en dos pasos",
  text: "La verificación en dos pasos de tu cuenta Seventwo quedó desactivada. Si no fuiste tú, cambia tu contraseña.",
  html: layout({
    titulo: "Verificación en dos pasos desactivada",
    contenido: `${hola(name)}
      <p>La <strong>verificación en dos pasos</strong> de tu cuenta quedó desactivada. Ya no te pediremos un código al iniciar sesión.</p>
      <p style="color:#71717a;font-size:13px;">Si no fuiste tú, alguien tiene acceso a tu cuenta:
      <a href="${escapeHtml(`${FRONTEND_URL}/olvide-contrasena`)}">restablece tu contraseña</a> y vuelve a activarla.</p>`,
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
