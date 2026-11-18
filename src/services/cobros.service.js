// src/services/cobros.service.js — cobros, pagos y comprobantes (F3 de docs/CLIENTES.md).
// Un cobro es lo que el cliente debe pagar (una mensualidad, un hito o algo manual);
// sus pagos confirmados deciden el estado: pendiente → parcial → pagado.
import { pool, enTransaccion } from "../db.js";
import { EQUIPO_EMAIL, FRONTEND_URL } from "../config.js";
import * as plantillas from "../emails/cobros.js";
import { escapeTg } from "../lib/telegram.js";
import { equipo, notificarEnSegundoPlano } from "./notificaciones.service.js";
import { registrarActividad } from "./clientes.service.js";

export const VIAS = ["mercadopago", "nequi", "transferencia", "efectivo", "tarjeta", "otro"];
export const ETIQUETA_VIA = {
  mercadopago: "Mercado Pago", nequi: "Nequi", transferencia: "Transferencia", efectivo: "Efectivo", tarjeta: "Tarjeta", otro: "Otro",
};
export const ABIERTOS = ["pendiente", "parcial"];
// Proyectos que siguen generando mensualidades.
export const PROYECTO_COBRABLE = ["en_curso", "entregado", "mantenimiento"];
export const ZONA = "America/Bogota";
export const MAX_COMPROBANTE = 5 * 1024 * 1024;
export const TIPOS_COMPROBANTE = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

export const rutaPagosCliente = (codigo) => `/area-cliente?seccion=pagos${codigo ? `&cobro=${encodeURIComponent(codigo)}` : ""}`;
export const rutaPagosAdmin = () => "/admin?seccion=pagos";
const abs = (ruta) => `${FRONTEND_URL}${ruta}`;

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export const fechaCorta = (iso) => {
  const [a, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return `${d} ${MESES[m - 1]} ${a}`;
};
export const dinero = (n, moneda = "COP") =>
  moneda === "USD" ? `US$ ${Number(n).toFixed(2)}` : `$ ${Math.round(Number(n)).toLocaleString("es-CO")}`;

/** ¿El contenido es realmente del tipo declarado? (cabeceras de JPG, PNG, WEBP y PDF) */
export function tipoReal(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

/** Recalcula estado y fecha de pago de un cobro a partir de sus pagos confirmados. */
export async function recalcularCobro(db, cobroId) {
  const { rows: [c] } = await db.query(
    `UPDATE cobros c SET
        estado = CASE
          WHEN c.estado = 'anulado' THEN 'anulado'
          WHEN s.pagado >= c.importe THEN 'pagado'
          WHEN s.pagado > 0 THEN 'parcial'
          ELSE 'pendiente' END,
        pagado_en = CASE WHEN s.pagado >= c.importe THEN s.ultima ELSE NULL END
       FROM (SELECT COALESCE(sum(importe), 0) AS pagado, max(fecha_pago) AS ultima
               FROM pagos WHERE cobro_id = $1 AND estado = 'confirmado') s
      WHERE c.id = $1
      RETURNING c.*`,
    [cobroId],
  );
  return c;
}

/** Cobros (con pagos) de un proyecto o de un cliente. El cliente no ve campos internos. */
export async function cobrosDe(db, { proyectoId, clienteId, paraCliente = false }) {
  const filtro = proyectoId ? "c.proyecto_id = $1" : "c.cliente_id = $1";
  const { rows: cobros } = await db.query(
    `SELECT c.id, c.codigo, c.tipo, c.concepto, c.periodo_inicio, c.periodo_fin, c.importe, c.moneda,
            c.fecha_vencimiento, c.estado, c.pagado_en, c.anulado_motivo, c.created_at,
            p.codigo AS proyecto_codigo, p.nombre AS proyecto_nombre,
            COALESCE((SELECT sum(importe) FROM pagos WHERE cobro_id = c.id AND estado = 'confirmado'), 0) AS pagado,
            (c.estado IN ('pendiente', 'parcial') AND c.fecha_vencimiento < (now() AT TIME ZONE '${ZONA}')::date) AS vencido
       FROM cobros c JOIN proyectos p ON p.id = c.proyecto_id
      WHERE ${filtro}
      ORDER BY c.fecha_vencimiento DESC, c.id DESC`,
    [proyectoId ?? clienteId],
  );
  if (!cobros.length) return [];
  const { rows: pagos } = await db.query(
    `SELECT pg.id, pg.cobro_id, pg.importe, pg.moneda, pg.fecha_pago, pg.via, pg.estado, pg.referencia, pg.created_at,
            pg.rechazo_motivo, pg.comprobante_archivo_id IS NOT NULL AS tiene_comprobante,
            a.nombre_original AS comprobante_nombre, a.mime AS comprobante_mime
            ${paraCliente ? "" : ", pg.notas, pg.lectura_ia, r.name AS registrado_por_nombre, cf.name AS confirmado_por_nombre, pg.confirmado_en"}
       FROM pagos pg
       LEFT JOIN archivos a ON a.id = pg.comprobante_archivo_id
       ${paraCliente ? "" : "LEFT JOIN usuarios r ON r.id = pg.registrado_por LEFT JOIN usuarios cf ON cf.id = pg.confirmado_por"}
      WHERE pg.cobro_id = ANY($1::bigint[])
      ORDER BY pg.fecha_pago, pg.id`,
    [cobros.map((c) => c.id)],
  );
  return cobros.map((c) => ({ ...c, pagos: pagos.filter((p) => String(p.cobro_id) === String(c.id)) }));
}

/** Estado de cuenta del cliente: pendiente, vencido y próximo vencimiento. */
export async function estadoCuenta(db, clienteId) {
  const { rows: [r] } = await db.query(
    `SELECT
       COALESCE(sum(c.importe - COALESCE(s.pagado, 0)) FILTER (WHERE c.estado IN ('pendiente','parcial')), 0) AS pendiente,
       COALESCE(sum(c.importe - COALESCE(s.pagado, 0)) FILTER (WHERE c.estado IN ('pendiente','parcial') AND c.fecha_vencimiento < (now() AT TIME ZONE '${ZONA}')::date), 0) AS vencido,
       min(c.fecha_vencimiento) FILTER (WHERE c.estado IN ('pendiente','parcial')) AS proximo_vencimiento,
       count(*) FILTER (WHERE c.estado = 'pagado')::int AS cobros_pagados,
       (SELECT count(*)::int FROM pagos WHERE cliente_id = $1 AND estado = 'en_verificacion') AS en_verificacion
     FROM cobros c
     LEFT JOIN (SELECT cobro_id, sum(importe) AS pagado FROM pagos WHERE estado = 'confirmado' GROUP BY cobro_id) s ON s.cobro_id = c.id
     WHERE c.cliente_id = $1`,
    [clienteId],
  );
  // Próximo cobro recurrente aún no generado (para mostrar "próximo cobro").
  const { rows: [prox] } = await db.query(
    `SELECT min(proximo_cobro) AS proximo, (array_agg(importe_periodo ORDER BY proximo_cobro))[1] AS importe
       FROM proyectos WHERE cliente_id = $1 AND modelo_cobro = 'recurrente' AND estado = ANY($2) AND proximo_cobro IS NOT NULL`,
    [clienteId, PROYECTO_COBRABLE],
  );
  return { ...r, proximo_recurrente: prox?.proximo ?? null, importe_recurrente: prox?.importe ?? null };
}

// ── Cobros recurrentes ───────────────────────────────────────────

const INTERVALO = { mensual: "1 month", trimestral: "3 months", anual: "1 year" };

/**
 * Genera las mensualidades (o trimestres/años) de los proyectos recurrentes cuyo
 * próximo cobro cae dentro de su ventana de recordatorio. Idempotente: un único
 * cobro por proyecto y fecha. Los que ya vencieron al generarse (alta de un
 * cliente con historial) se crean "en silencio": sin recordatorio ni aviso de vencido.
 * @returns {Promise<number>} cobros creados
 */
export async function generarCobrosRecurrentes({ proyectoId = null } = {}) {
  const { rows: proyectos } = await pool.query(
    `SELECT id FROM proyectos
      WHERE modelo_cobro = 'recurrente' AND estado = ANY($1) AND importe_periodo > 0
        AND periodicidad IS NOT NULL AND proximo_cobro IS NOT NULL
        AND proximo_cobro <= (now() AT TIME ZONE '${ZONA}')::date + recordatorio_dias
        ${proyectoId ? "AND id = $2" : ""}`,
    proyectoId ? [PROYECTO_COBRABLE, proyectoId] : [PROYECTO_COBRABLE],
  );
  let creados = 0;
  for (const { id } of proyectos) {
    creados += await enTransaccion(async (db) => {
      const { rows: [p] } = await db.query("SELECT * FROM proyectos WHERE id = $1 FOR UPDATE", [id]);
      let n = 0;
      // Tope de seguridad: 10 años de mensualidades por pasada.
      for (let i = 0; i < 120; i++) {
        const { rows: [f] } = await db.query(
          `SELECT $1::date AS venc, ($1::date - $2::interval)::date AS ini, ($1::date - 1) AS fin,
                  ($1::date + $2::interval)::date AS siguiente,
                  $1::date <= (now() AT TIME ZONE '${ZONA}')::date + $3::int AS toca,
                  $1::date < (now() AT TIME ZONE '${ZONA}')::date AS pasado`,
          [p.proximo_cobro, INTERVALO[p.periodicidad], p.recordatorio_dias],
        );
        if (!f.toca) break;
        const concepto = `${p.nombre} · ${fechaCorta(f.ini)} – ${fechaCorta(f.fin)}`.slice(0, 200);
        const { rowCount } = await db.query(
          `INSERT INTO cobros (cliente_id, proyecto_id, tipo, concepto, periodo_inicio, periodo_fin, importe, moneda,
                               fecha_vencimiento, recordatorio_enviado_en, vencido_avisado_en)
           VALUES ($1, $2, 'recurrente', $3, $4, $5, $6, $7, $8, $9, $9)
           ON CONFLICT DO NOTHING`,
          [p.cliente_id, p.id, concepto, f.ini, f.fin, p.importe_periodo, p.moneda, f.venc, f.pasado ? new Date() : null],
        );
        n += rowCount;
        p.proximo_cobro = f.siguiente;
      }
      await db.query("UPDATE proyectos SET proximo_cobro = $2 WHERE id = $1", [id, p.proximo_cobro]);
      if (n) {
        await registrarActividad(db, {
          cliente_id: p.cliente_id, entidad: "proyecto", entidad_id: p.id, accion: "cobros_generados",
          descripcion: `${n} cobro(s) de ${p.codigo} generados automáticamente`, visible_cliente: false,
        });
      }
      return n;
    });
  }
  return creados;
}

// ── Avisos ───────────────────────────────────────────────────────

async function cuentaDe(clienteId) {
  const { rows: [r] } = await pool.query(
    `SELECT cl.email, cl.email_facturacion, cl.nombre, cl.contacto_nombre, u.id, u.socket_id, u.name
       FROM clientes cl LEFT JOIN usuarios u ON u.id = cl.usuario_id AND NOT u.bloqueado
      WHERE cl.id = $1`,
    [clienteId],
  );
  return r;
}

/** Recordatorio N días antes y aviso de vencido (una vez cada uno). */
export async function avisarCobros() {
  const { rows: proximos } = await pool.query(
    `SELECT c.*, p.recordatorio_dias, p.codigo AS proyecto_codigo FROM cobros c JOIN proyectos p ON p.id = c.proyecto_id
      WHERE c.estado IN ('pendiente', 'parcial') AND c.recordatorio_enviado_en IS NULL
        AND c.fecha_vencimiento >= (now() AT TIME ZONE '${ZONA}')::date
        AND c.fecha_vencimiento - p.recordatorio_dias <= (now() AT TIME ZONE '${ZONA}')::date`,
  );
  for (const c of proximos) {
    const { rowCount } = await pool.query("UPDATE cobros SET recordatorio_enviado_en = now() WHERE id = $1 AND recordatorio_enviado_en IS NULL", [c.id]);
    if (rowCount) await avisarCliente(c, "recordatorio");
  }
  const { rows: vencidos } = await pool.query(
    `SELECT c.*, p.codigo AS proyecto_codigo FROM cobros c JOIN proyectos p ON p.id = c.proyecto_id
      WHERE c.estado IN ('pendiente', 'parcial') AND c.vencido_avisado_en IS NULL
        AND c.fecha_vencimiento < (now() AT TIME ZONE '${ZONA}')::date`,
  );
  for (const c of vencidos) {
    const { rowCount } = await pool.query("UPDATE cobros SET vencido_avisado_en = now() WHERE id = $1 AND vencido_avisado_en IS NULL", [c.id]);
    if (!rowCount) continue;
    await avisarCliente(c, "vencido");
    const cl = await cuentaDe(c.cliente_id);
    notificarEnSegundoPlano({
      usuarios: await equipo(),
      tipo: "cobro_vencido",
      titulo: `Cobro vencido: ${cl.nombre}`,
      cuerpo: `${c.codigo} · ${dinero(c.importe, c.moneda)} · venció ${fechaCorta(c.fecha_vencimiento)}`,
      url: rutaPagosAdmin(),
      datos: { cobro_id: c.id },
      telegram: {
        html: `⏰ <b>Cobro vencido</b> · ${escapeTg(cl.nombre)}\n${escapeTg(c.codigo)} · ${escapeTg(c.concepto)}\n💰 ${escapeTg(dinero(c.importe, c.moneda))} · venció ${escapeTg(fechaCorta(c.fecha_vencimiento))}`,
        boton: { texto: "Ver pagos", url: abs(rutaPagosAdmin()) },
      },
    });
  }
  return { recordatorios: proximos.length, vencidos: vencidos.length };
}

async function avisarCliente(c, tipo) {
  const cl = await cuentaDe(c.cliente_id);
  const ruta = rutaPagosCliente(c.codigo);
  const datos = {
    name: cl.name ?? cl.contacto_nombre ?? cl.nombre, codigo: c.codigo, concepto: c.concepto,
    importe: dinero(c.importe, c.moneda), fecha: fechaCorta(c.fecha_vencimiento),
    urlCta: cl.id ? abs(ruta) : abs(`/registro?email=${encodeURIComponent(cl.email)}&next=${encodeURIComponent(ruta)}`),
    textoCta: cl.id ? "Ver y adjuntar el pago" : "Crea tu cuenta para verlo",
  };
  notificarEnSegundoPlano({
    usuarios: cl.id ? [cl] : [],
    tipo: tipo === "recordatorio" ? "cobro_recordatorio" : "cobro_vencido_cliente",
    titulo: tipo === "recordatorio" ? `Tu pago de ${datos.importe} vence el ${datos.fecha}` : `Tu pago de ${datos.importe} está vencido`,
    cuerpo: c.concepto,
    url: ruta,
    datos: { codigo: c.codigo },
    email: {
      to: cl.email_facturacion || cl.email,
      replyTo: EQUIPO_EMAIL,
      ...(tipo === "recordatorio" ? plantillas.cobroRecordatorio(datos) : plantillas.cobroVencido(datos)),
    },
  });
}

/** El cliente subió un comprobante: el equipo debe verificarlo. */
export async function avisarComprobante(pago, cobro, lectura = null) {
  const cl = await cuentaDe(cobro.cliente_id);
  const MARCA = { coincide: "✅", nueva: "✅", distinto: "⚠️", fuera_de_rango: "⚠️", ya_usada: "🚫", sin_dato: "❔" };
  const lineaIa = lectura
    ? `\n🤖 Lectura: ${lectura.importe != null ? escapeTg(dinero(lectura.importe)) : "¿importe?"} ${MARCA[lectura.contraste.importe]}` +
      ` · ${escapeTg(lectura.fecha ?? "¿fecha?")} ${MARCA[lectura.contraste.fecha]}` +
      ` · ref ${escapeTg(lectura.referencia ?? "—")} ${MARCA[lectura.contraste.referencia]}` +
      `${lectura.es_comprobante ? "" : "\n🚫 No parece un comprobante"}`
    : "";
  notificarEnSegundoPlano({
    usuarios: await equipo(),
    tipo: "pago_comprobante",
    titulo: `${cl.nombre} subió un comprobante`,
    cuerpo: `${cobro.codigo} · ${dinero(pago.importe, pago.moneda)} · ${ETIQUETA_VIA[pago.via]}`,
    url: rutaPagosAdmin(),
    datos: { pago_id: pago.id, cobro_id: cobro.id },
    email: {
      to: EQUIPO_EMAIL,
      ...plantillas.comprobanteEquipo({ cliente: cl.nombre, codigo: cobro.codigo, concepto: cobro.concepto, importe: dinero(pago.importe, pago.moneda), via: ETIQUETA_VIA[pago.via], url: abs(rutaPagosAdmin()) }),
    },
    telegram: {
      html: `🧾 <b>${escapeTg(cl.nombre)}</b> subió un comprobante\n${escapeTg(cobro.codigo)} · ${escapeTg(cobro.concepto)}\n💰 ${escapeTg(dinero(pago.importe, pago.moneda))} · ${escapeTg(ETIQUETA_VIA[pago.via])}${lineaIa}`,
      boton: { texto: "Revisar pago", url: abs(rutaPagosAdmin()) },
    },
  });
}

/** Pago recibido por Mercado Pago (confirmado automáticamente): aviso al equipo. */
export async function avisarPagoMercadoPago(pago, cobro) {
  const cl = await cuentaDe(cobro.cliente_id);
  notificarEnSegundoPlano({
    usuarios: await equipo(),
    tipo: "pago_mercadopago",
    titulo: `${cl.nombre} pagó con Mercado Pago`,
    cuerpo: `${cobro.codigo} · ${dinero(pago.importe, pago.moneda)}`,
    url: rutaPagosAdmin(),
    datos: { pago_id: pago.id, cobro_id: cobro.id },
    telegram: {
      html: `💳 <b>${escapeTg(cl.nombre)}</b> pagó con Mercado Pago\n${escapeTg(cobro.codigo)} · ${escapeTg(cobro.concepto)}\n💰 ${escapeTg(dinero(pago.importe, pago.moneda))} · confirmado ✅`,
    },
  });
}

/** Pago confirmado o rechazado: aviso al cliente (in-app; email si fue rechazado). */
export async function avisarResultadoPago(pago, cobro, { confirmado, motivo }) {
  const cl = await cuentaDe(cobro.cliente_id);
  const ruta = rutaPagosCliente(cobro.codigo);
  notificarEnSegundoPlano({
    usuarios: cl.id ? [cl] : [],
    tipo: confirmado ? "pago_confirmado" : "pago_rechazado",
    titulo: confirmado ? `Pago confirmado · ${cobro.codigo}` : `No pudimos confirmar tu pago · ${cobro.codigo}`,
    cuerpo: confirmado ? `${dinero(pago.importe, pago.moneda)} · ${cobro.concepto}` : motivo,
    url: ruta,
    datos: { codigo: cobro.codigo },
    email: confirmado ? undefined : {
      to: cl.email_facturacion || cl.email,
      replyTo: EQUIPO_EMAIL,
      ...plantillas.pagoRechazado({ name: cl.name ?? cl.nombre, codigo: cobro.codigo, concepto: cobro.concepto, motivo, urlCta: abs(ruta) }),
    },
  });
}
