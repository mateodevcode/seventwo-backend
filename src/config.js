// src/config.js — lectura y validación de variables de entorno.
// Falla al arrancar si falta algo crítico: mejor no levantar que levantar inseguro.

const env = process.env;

export const NODE_ENV = env.NODE_ENV || "development";
export const IS_PROD = NODE_ENV === "production";
export const PORT = Number(env.PORT) || 4000;

// Conexión a Postgres: DATABASE_URL, o bien DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
// (convención de inmobitwo; evita codificar la contraseña en una URL).
// Si están ambas, gana DATABASE_URL.
export const DATABASE_URL = env.DATABASE_URL || undefined;
export const DB_CONFIG = DATABASE_URL
  ? { connectionString: DATABASE_URL }
  : env.DB_HOST
    ? {
        host: env.DB_HOST,
        port: Number(env.DB_PORT) || 5432,
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        database: env.DB_NAME,
      }
    : null;

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

// ── Notificaciones (docs/PRESUPUESTOS.md §6). Cada canal se activa solo si
// sus variables existen; sin ellas, el resto funciona igual.
// Buzón del equipo que recibe el email de cada solicitud nueva y las respuestas.
export const EQUIPO_EMAIL = env.EQUIPO_EMAIL || env.BREVO_EMAIL_INFO || "info@seventwo.tech";

export const SOCKET_CORE_URL = env.SOCKET_CORE_URL?.replace(/\/$/, "");
export const SOCKET_CORE_API_KEY = env.SOCKET_CORE_API_KEY;
export const SOCKET_CORE_CANAL = env.SOCKET_CORE_CANAL || "seventwo:notificaciones";

export const VAPID_PUBLIC_KEY = env.VAPID_PUBLIC_KEY;
export const VAPID_PRIVATE_KEY = env.VAPID_PRIVATE_KEY;
export const VAPID_SUBJECT = env.VAPID_SUBJECT || "mailto:admin@seventwo.tech";

export const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;

export const socketConfigurado = () => Boolean(SOCKET_CORE_URL && SOCKET_CORE_API_KEY);
export const pushConfigurado = () => Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
export const telegramConfigurado = () => Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

export const emailConfigurado = () => Boolean(BREVO_SMTP_EMAIL && BREVO_SMTP_PASS);
export const googleConfigurado = () =>
  Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);

export function validarConfig() {
  const errores = [];

  if (!DB_CONFIG) {
    errores.push("Falta la base de datos: define DATABASE_URL o DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME.");
  } else if (!DATABASE_URL) {
    for (const k of ["DB_USER", "DB_PASSWORD", "DB_NAME"]) if (!env[k]) errores.push(`${k} es obligatoria.`);
  }

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
  const off = [
    !socketConfigurado() && "socket-core (tiempo real)",
    !pushConfigurado() && "Web Push",
    !telegramConfigurado() && "Telegram",
  ].filter(Boolean);
  if (off.length) console.warn(`ℹ️  Canales de aviso desactivados: ${off.join(", ")}.`);
}
