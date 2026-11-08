// src/lib/telegram.js — avisos al grupo del equipo vía Bot API.
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, telegramConfigurado } from "../config.js";

export const escapeTg = (s) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/**
 * @param {string} html  texto con el subconjunto HTML de Telegram (<b>, <i>, <a>…), ya escapado
 * @param {{ texto: string, url: string }} [boton]
 */
export async function enviarTelegram(html, boton) {
  if (!telegramConfigurado()) return { omitido: true };
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text: html.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  // Telegram rechaza botones con URL http/localhost: solo se añade con https.
  if (boton?.url?.startsWith("https://")) {
    body.reply_markup = { inline_keyboard: [[{ text: boton.texto, url: boton.url }]] };
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`Telegram ${res.status}: ${j.description ?? ""}`);
  }
  return { ok: true };
}
