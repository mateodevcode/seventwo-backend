// src/config.js — lectura y validación de variables de entorno.
// Falla al arrancar si falta algo crítico: mejor no levantar que levantar inseguro.

const env = process.env;

export const NODE_ENV = env.NODE_ENV || "development";
export const IS_PROD = NODE_ENV === "production";
export const PORT = Number(env.PORT) || 4000;

export const DATABASE_URL = env.DATABASE_URL;

export const FRONTEND_URLS = String(env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((u) => u.trim().replace(/\/$/, ""))
  .filter(Boolean);
export const FRONTEND_URL = FRONTEND_URLS[0];
export const COOKIE_DOMAIN = env.COOKIE_DOMAIN?.trim() || undefined;

export const JWT_SECRET = env.JWT_SECRET;
export const JWT_REFRESH_SECRET = env.JWT_REFRESH_SECRET;
export const AUTH_PEPPER = env.AUTH_PEPPER;

export const BREVO_SMTP_EMAIL = env.BREVO_SMTP_EMAIL;
export const BREVO_SMTP_PASS = env.BREVO_SMTP_PASS;
export const BREVO_EMAIL_NO_REPLY = env.BREVO_EMAIL_NO_REPLY || "no-reply@seventwo.tech";

export const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
export const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
export const GOOGLE_REDIRECT_URI = env.GOOGLE_REDIRECT_URI;

export const emailConfigurado = () => Boolean(BREVO_SMTP_EMAIL && BREVO_SMTP_PASS);
export const googleConfigurado = () =>
  Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);

export function validarConfig() {
  const errores = [];

  if (!DATABASE_URL) errores.push("DATABASE_URL es obligatoria.");

  for (const [nombre, valor] of [
    ["JWT_SECRET", JWT_SECRET],
    ["JWT_REFRESH_SECRET", JWT_REFRESH_SECRET],
    ["AUTH_PEPPER", AUTH_PEPPER],
  ]) {
    if (!valor) errores.push(`${nombre} es obligatoria.`);
    else if (valor.length < 32) errores.push(`${nombre} debe tener al menos 32 caracteres.`);
  }
  if (JWT_SECRET && JWT_SECRET === JWT_REFRESH_SECRET) {
    errores.push("JWT_SECRET y JWT_REFRESH_SECRET deben ser distintos.");
  }

  if (IS_PROD) {
    if (!emailConfigurado()) errores.push("BREVO_SMTP_EMAIL y BREVO_SMTP_PASS son obligatorias en producción.");
    if (!COOKIE_DOMAIN) errores.push("COOKIE_DOMAIN es obligatoria en producción (p. ej. .seventwo.tech).");
  }

  if (errores.length) {
    throw new Error(`Configuración inválida:\n  - ${errores.join("\n  - ")}`);
  }

  if (!emailConfigurado()) {
    console.warn("⚠️  SMTP no configurado: los emails se imprimirán en consola (solo desarrollo).");
  }
  if (!googleConfigurado()) {
    console.warn("⚠️  Google OAuth no configurado: /auth/google responderá 503.");
  }
}
