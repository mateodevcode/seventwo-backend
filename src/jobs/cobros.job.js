// src/jobs/cobros.job.js — cada hora: genera las mensualidades que tocan,
// envía recordatorios N días antes y avisa de los cobros vencidos (F3).
import { avisarCobros, generarCobrosRecurrentes } from "../services/cobros.service.js";

const CADA_MS = 60 * 60 * 1000;

export async function revisarCobros() {
  const creados = await generarCobrosRecurrentes();
  const { recordatorios, vencidos } = await avisarCobros();
  if (creados || recordatorios || vencidos) {
    console.log(`💳 Cobros: ${creados} generados, ${recordatorios} recordatorios, ${vencidos} vencidos avisados.`);
  }
}

export function iniciarCobros() {
  const correr = () => revisarCobros().catch((e) => console.error("❌ Revisión de cobros falló:", e.message));
  setTimeout(correr, 15_000).unref(); // tras el arranque (migraciones ya aplicadas)
  return setInterval(correr, CADA_MS).unref();
}
