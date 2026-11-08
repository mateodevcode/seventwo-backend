// src/services/envio.service.js — envío de códigos y avisos por email.
import { HttpError } from "../lib/errors.js";
import { enviarEmail } from "../lib/mailer.js";
import { emitirCodigo, invalidarCodigos } from "./codigos.service.js";

/**
 * Emite un código del `tipo` dado y lo envía con la plantilla.
 * Si el email falla invalida el código y lanza 502.
 */
export async function enviarCodigo(usuario, tipo, plantilla, opciones = {}) {
  const codigo = await emitirCodigo({ usuarioId: usuario.id, tipo, ...opciones });
  try {
    await enviarEmail({ to: usuario.email, ...plantilla({ name: usuario.name, codigo }) });
  } catch (error) {
    console.error(`❌ No se pudo enviar el email (${tipo}) a ${usuario.email}:`, error.message);
    await invalidarCodigos(usuario.id, tipo);
    throw new HttpError(502, "No pudimos enviar el código. Intenta de nuevo en unos minutos.");
  }
}

// Aviso informativo (cuenta bloqueada, OTP activado…): no bloquea la respuesta
// ni la hace fallar si el email no sale.
export function notificar(usuario, plantilla, datos = {}) {
  enviarEmail({ to: usuario.email, ...plantilla({ name: usuario.name, ...datos }) }).catch((e) =>
    console.error(`❌ Aviso por email no enviado a ${usuario.email}:`, e.message),
  );
}
