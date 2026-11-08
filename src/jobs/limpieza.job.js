// src/jobs/limpieza.job.js — borra códigos, rate limits y refresh tokens caducados.
import { pool } from "../db.js";

const CADA_MS = 60 * 60 * 1000; // 1 hora

export async function limpiar() {
  const r1 = await pool.query(
    "DELETE FROM auth_codigos WHERE expira_en < now() - interval '1 day' OR usado_en < now() - interval '1 day'",
  );
  const r2 = await pool.query("DELETE FROM rate_limits WHERE expira_en < now()");
  const r3 = await pool.query(
    "DELETE FROM refresh_tokens WHERE expira_en < now() OR (revocado AND created_at < now() - interval '30 days')",
  );
  const total = r1.rowCount + r2.rowCount + r3.rowCount;
  if (total) console.log(`🧹 Limpieza: ${r1.rowCount} códigos, ${r2.rowCount} rate limits, ${r3.rowCount} refresh tokens.`);
}

export function iniciarLimpieza() {
  const correr = () => limpiar().catch((e) => console.error("❌ Limpieza falló:", e.message));
  correr();
  return setInterval(correr, CADA_MS).unref();
}
