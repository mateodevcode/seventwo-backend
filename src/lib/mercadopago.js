// src/lib/mercadopago.js — Checkout Pro de Mercado Pago (F4 de docs/CLIENTES.md §6.1).
// - Preferencia: el cliente paga en la página de MP (tarjeta, PSE, Nequi…).
// - Webhook: se verifica la firma x-signature y luego se CONSULTA el pago a la
//   API de MP; nunca se confía en el cuerpo de la notificación.
// Docs: https://www.mercadopago.com.co/developers/es/docs/checkout-pro/overview
import crypto from "node:crypto";
import { MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, NODE_ENV } from "../config.js";
import { HttpError } from "./errors.js";

const API = "https://api.mercadopago.com";
// MP reintenta notificaciones durante días: tolerancia amplia para el ts (como en inmobitwo).
const TOLERANCIA_TS_MS = 7 * 24 * 60 * 60 * 1000;

export const modoPrueba = () => String(MP_ACCESS_TOKEN ?? "").startsWith("TEST-");

// Inyectable en tests (sin red).
let fetchMp = (...a) => fetch(...a);
export const _usarFetchPruebas = (fn) => { fetchMp = fn; };

async function llamar(ruta, { method = "GET", body, idempotencia } = {}) {
  if (!MP_ACCESS_TOKEN && NODE_ENV !== "test") throw new HttpError(503, "Mercado Pago no está configurado.");
  const res = await fetchMp(`${API}${ruta}`, {
    method,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN ?? "test"}`,
      "Content-Type": "application/json",
      ...(idempotencia && { "X-Idempotency-Key": idempotencia }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`❌ Mercado Pago ${method} ${ruta}: HTTP ${res.status} ${json?.message ?? ""}`);
    throw new HttpError(502, "Mercado Pago no respondió correctamente. Inténtalo de nuevo.");
  }
  return json;
}

/**
 * Crea la preferencia de pago de un cobro. Devuelve la URL a la que se redirige al cliente.
 * external_reference = "cobro:<id>" identifica el cobro al volver el webhook.
 */
export async function crearPreferencia({ cobro, importe, pagador, urlVuelta, urlWebhook }) {
  const pref = await llamar("/checkout/preferences", {
    method: "POST",
    idempotencia: `seventwo-cobro-${cobro.id}-${Math.round(importe)}-${new Date().toISOString().slice(0, 13)}`,
    body: {
      items: [{
        id: cobro.codigo,
        title: `${cobro.codigo} · ${cobro.concepto}`.slice(0, 250),
        quantity: 1,
        unit_price: Number(importe),
        currency_id: cobro.moneda || "COP",
      }],
      payer: pagador?.email ? { email: pagador.email, name: pagador.nombre } : undefined,
      external_reference: `cobro:${cobro.id}`,
      metadata: { cobro_codigo: cobro.codigo },
      back_urls: { success: urlVuelta, pending: urlVuelta, failure: urlVuelta },
      auto_return: "approved",
      notification_url: urlWebhook,
      statement_descriptor: "SEVENTWO",
    },
  });
  return { id: pref.id, url: modoPrueba() ? pref.sandbox_init_point ?? pref.init_point : pref.init_point };
}

export const obtenerPago = (id) => llamar(`/v1/payments/${encodeURIComponent(id)}`);

/** Verifica x-signature: HMAC-SHA256 de "id:<data.id>;request-id:<x-request-id>;ts:<ts>;". */
export function firmaValida({ firma, requestId, dataId, ahora = Date.now() }) {
  if (!MP_WEBHOOK_SECRET) return false;
  const ts = String(firma ?? "").match(/ts=(\d+)/)?.[1];
  const v1 = String(firma ?? "").match(/v1=([a-f0-9]+)/i)?.[1]?.toLowerCase();
  if (!ts || !v1) return false;
  const tsMs = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
  if (!Number.isFinite(tsMs) || Math.abs(ahora - tsMs) > TOLERANCIA_TS_MS) return false;
  const id = String(dataId ?? "").trim();
  const variantes = [...new Set([id, id.toLowerCase()])];
  return variantes.some((x) => {
    const partes = [x && `id:${x}`, requestId && `request-id:${String(requestId).trim()}`, `ts:${ts}`].filter(Boolean);
    const calculado = crypto.createHmac("sha256", MP_WEBHOOK_SECRET).update(`${partes.join(";")};`).digest("hex");
    const a = Buffer.from(calculado);
    const b = Buffer.from(v1);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}
