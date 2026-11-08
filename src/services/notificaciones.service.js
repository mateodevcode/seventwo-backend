// src/services/notificaciones.service.js — un aviso, cinco salidas (docs/PRESUPUESTOS.md §6):
//   1. BD (bandeja de la campana; fuente de verdad)   2. socket-core (tiempo real)
//   3. Web Push (app instalada)   4. Email   5. Telegram (solo equipo)
// Cada salida es independiente: un fallo se registra y no afecta a las demás
// ni a quien llama (que normalmente no espera la promesa).
import { pool } from "../db.js";
import { enviarEmail } from "../lib/mailer.js";
import { emitir } from "../lib/socketCore.js";
import { enviarPush } from "../lib/webpush.js";
import { enviarTelegram } from "../lib/telegram.js";

/** Admins y superadmins activos. */
export async function equipo() {
  const { rows } = await pool.query(
    "SELECT id, socket_id FROM usuarios WHERE rol IN ('admin', 'superadmin') AND NOT bloqueado",
  );
  return rows;
}

/**
 * @param {object} aviso
 * @param {Array<{id:number, socket_id:string}>} [aviso.usuarios]  destinatarios in-app (BD + socket + push)
 * @param {string} aviso.tipo     p. ej. 'solicitud_nueva'
 * @param {string} aviso.titulo
 * @param {string} [aviso.cuerpo]
 * @param {string} [aviso.url]    ruta relativa del front (/admin?solicitud=12)
 * @param {object} [aviso.datos]
 * @param {{to:string, subject:string, html:string, text?:string, replyTo?:string}} [aviso.email]
 * @param {{html:string, boton?:{texto:string,url:string}}} [aviso.telegram]
 * @returns {Promise<Record<string,string>>} resultado por canal (para logs/tests)
 */
export async function notificar({ usuarios = [], tipo, titulo, cuerpo = null, url = null, datos = null, email, telegram }) {
  const ids = usuarios.map((u) => u.id);
  const resumen = {};

  // 1. BD primero: si esto falla, sí interesa saberlo (la campana es la fuente de verdad).
  let filas = [];
  if (ids.length) {
    const { rows } = await pool.query(
      `INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, url, datos)
       SELECT unnest($1::int[]), $2, $3, $4, $5, $6
       RETURNING id, usuario_id, tipo, titulo, cuerpo, url, datos, created_at`,
      [ids, tipo, titulo.slice(0, 160), cuerpo?.slice(0, 500) ?? null, url, datos],
    );
    filas = rows;
  }
  resumen.bd = `${filas.length}`;

  const evento = { tipo: "notificacion", notificacion: { tipo, titulo, cuerpo, url, datos } };
  const salidas = {
    socket: () => emitir(usuarios.map((u) => u.socket_id), evento),
    push: () => enviarPush(ids, { title: titulo, body: cuerpo ?? "", url: url ?? "/", tag: tipo }),
    email: () => (email ? enviarEmail(email) : { omitido: true }),
    telegram: () => (telegram ? enviarTelegram(telegram.html, telegram.boton) : { omitido: true }),
  };

  const nombres = Object.keys(salidas);
  const resultados = await Promise.allSettled(nombres.map((n) => salidas[n]()));
  resultados.forEach((r, i) => {
    const canal = nombres[i];
    if (r.status === "rejected") {
      resumen[canal] = "error";
      console.error(`❌ Aviso '${tipo}' por ${canal} falló:`, r.reason?.message ?? r.reason);
    } else {
      resumen[canal] = r.value?.omitido ? "omitido" : "ok";
    }
  });
  return resumen;
}

/** Lanza `notificar` sin esperar y sin dejar promesas rechazadas sueltas. */
export const notificarEnSegundoPlano = (aviso) =>
  notificar(aviso).catch((e) => console.error(`❌ Aviso '${aviso.tipo}' no guardado:`, e.message));
