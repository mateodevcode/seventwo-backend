// src/lib/mailer.js — envío de emails con Nodemailer por SMTP de Brevo.
// Sin credenciales SMTP (solo desarrollo) el email se imprime en consola
// para poder probar los flujos con OTP sin cuenta de Brevo.
import nodemailer from "nodemailer";
import {
  BREVO_EMAIL_NO_REPLY,
  BREVO_SMTP_EMAIL,
  BREVO_SMTP_PASS,
  emailConfigurado,
} from "../config.js";

let transporter;

// Con NODE_ENV=test los emails simulados se guardan aquí (los tests leen los códigos).
export const bandejaPruebas = [];

export const createTransporter = () => {
  transporter ??= nodemailer.createTransport({
    host: "smtp-relay.brevo.com",
    port: 587,
    secure: false, // STARTTLS
    requireTLS: true,
    auth: { user: BREVO_SMTP_EMAIL, pass: BREVO_SMTP_PASS },
  });
  return transporter;
};

/**
 * @param {{ to: string, subject: string, html: string, text?: string, replyTo?: string }} email
 */
export async function enviarEmail({ to, subject, html, text, replyTo }) {
  if (process.env.NODE_ENV === "test") {
    bandejaPruebas.push({ to, subject, html, text, replyTo });
    return { simulado: true };
  }
  if (!emailConfigurado()) {
    console.log(
      `\n📧 [email simulado] Para: ${to}\n   Asunto: ${subject}\n   ${text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}\n`,
    );
    return { simulado: true };
  }
  return createTransporter().sendMail({
    from: `"Seventwo" <${BREVO_EMAIL_NO_REPLY}>`,
    to,
    subject,
    html,
    text,
    ...(replyTo && { replyTo }),
  });
}

// Comprueba la conexión SMTP al arrancar (solo informa, no tumba la API).
export async function verificarSmtp() {
  if (!emailConfigurado()) return;
  try {
    await createTransporter().verify();
    console.log("✉️  SMTP Brevo conectado.");
  } catch (error) {
    console.error("❌ No se pudo conectar al SMTP de Brevo:", error.message);
  }
}
