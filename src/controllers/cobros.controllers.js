// src/controllers/cobros.controllers.js — cobros, pagos y comprobantes (F3).
// Equipo: crear/anular cobros, registrar pagos (uno o en lote), verificar
// comprobantes y adjuntarlos. Cliente: ver sus cobros y adjuntar comprobantes.
import { enTransaccion, pool } from "../db.js";
import { HttpError, badRequest, conflict, notFound } from "../lib/errors.js";
import * as mp from "../lib/mercadopago.js";
import { API_PUBLIC_URL, FRONTEND_URL, mpConfigurado } from "../config.js";
import * as almacen from "../lib/almacen.js";
import * as v from "../lib/validar.js";
import { clienteDeUsuario, registrarActividad } from "../services/clientes.service.js";
import { contrastar, leerComprobante } from "../lib/lectorComprobantes.js";
import {
  ETIQUETA_VIA,
  MAX_COMPROBANTE,
  TIPOS_COMPROBANTE,
  VIAS,
  ZONA,
  avisarComprobante,
  avisarPagoMercadoPago,
  avisarResultadoPago,
  cobrosDe,
  dinero,
  estadoCuenta,
  fechaCorta,
  generarCobrosRecurrentes,
  recalcularCobro,
  tipoReal,
} from "../services/cobros.service.js";

const nombreCorto = (actor) => actor.name.split(" ")[0];
const idDe = (x, msg) => {
  const n = Number(x);
  if (!Number.isInteger(n) || n <= 0) throw notFound(msg);
  return n;
};
const errorCampo = (campo, e) => badRequest(typeof e === "string" ? e : "Dato no válido.", { errores: { [campo]: e } });

async function cobroPorId(db, id) {
  const { rows: [c] } = await db.query(
    "SELECT c.*, p.codigo AS proyecto_codigo FROM cobros c JOIN proyectos p ON p.id = c.proyecto_id WHERE c.id = $1",
    [idDe(id, "Cobro no encontrado.")],
  );
  if (!c) throw notFound("Cobro no encontrado.");
  return c;
}

async function pendienteDe(db, cobro) {
  const { rows: [{ pagado }] } = await db.query(
    "SELECT COALESCE(sum(importe), 0) AS pagado FROM pagos WHERE cobro_id = $1 AND estado IN ('confirmado', 'en_verificacion')",
    [cobro.id],
  );
  return Math.max(0, Math.round((Number(cobro.importe) - Number(pagado)) * 100) / 100);
}

/** Valida y sube un comprobante (imagen o PDF ≤ 5 MB). Devuelve el id de `archivos`. */
async function guardarComprobante(db, { buf, clienteId, actorId, nombre }) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw badRequest("Adjunta la foto o el PDF del comprobante.");
  if (buf.length > MAX_COMPROBANTE) throw badRequest("El comprobante supera los 5 MB.");
  const mime = tipoReal(buf);
  if (!mime) throw badRequest("El comprobante debe ser una imagen (JPG, PNG, WEBP) o un PDF.");
  const ext = TIPOS_COMPROBANTE[mime];
  const subido = await almacen.subir({ clave: almacen.clavePrivada(`comprobantes/${clienteId}`, ext), body: buf, contentType: mime });
  try {
    const limpio = String(nombre ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 150) || `comprobante.${ext}`;
    const { rows: [a] } = await db.query(
      `INSERT INTO archivos (cliente_id, subido_por, nombre_original, mime, bytes, sha256, s3_clave)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [clienteId, actorId, limpio, mime, subido.bytes, subido.sha256, subido.clave],
    );
    return { archivoId: a.id, clave: subido.clave, mime };
  } catch (e) {
    await almacen.borrar(subido.clave).catch(() => {});
    throw e;
  }
}

const reglasPago = {
  fecha_pago: (x) => v.fecha(x) ?? (() => { throw "La fecha del pago es obligatoria."; })(),
  via: (x) => v.opcion(x, VIAS, { requerido: true, nombre: "El medio de pago" }),
  referencia: (x) => v.texto(x, { max: 120, nombre: "La referencia" }),
  notas: (x) => v.texto(x, { max: 500, nombre: "Las notas" }),
  importe: (x) => v.dinero(x, { nombre: "El importe" }),
};

// ═════════════════════════ Equipo ═══════════════════════════════

// ── GET /admin/cobros?vista=verificar|vencidos|abiertos ──────────
export const panelPagos = async (req, res) => {
  const { rows: verificar } = await pool.query(
    `SELECT pg.id, pg.importe, pg.moneda, pg.fecha_pago, pg.via, pg.referencia, pg.created_at, pg.lectura_ia,
            pg.comprobante_archivo_id IS NOT NULL AS tiene_comprobante, a.mime AS comprobante_mime,
            c.id AS cobro_id, c.codigo AS cobro_codigo, c.concepto, c.importe AS cobro_importe,
            cl.id AS cliente_id, cl.nombre AS cliente, p.id AS proyecto_id, p.codigo AS proyecto_codigo
       FROM pagos pg JOIN cobros c ON c.id = pg.cobro_id JOIN clientes cl ON cl.id = pg.cliente_id
       JOIN proyectos p ON p.id = c.proyecto_id LEFT JOIN archivos a ON a.id = pg.comprobante_archivo_id
      WHERE pg.estado = 'en_verificacion' ORDER BY pg.created_at`,
  );
  const { rows: abiertos } = await pool.query(
    `SELECT c.id, c.codigo, c.concepto, c.importe, c.moneda, c.fecha_vencimiento, c.estado,
            c.fecha_vencimiento < (now() AT TIME ZONE '${ZONA}')::date AS vencido,
            COALESCE((SELECT sum(importe) FROM pagos WHERE cobro_id = c.id AND estado = 'confirmado'), 0) AS pagado,
            cl.id AS cliente_id, cl.nombre AS cliente, p.id AS proyecto_id, p.codigo AS proyecto_codigo
       FROM cobros c JOIN clientes cl ON cl.id = c.cliente_id JOIN proyectos p ON p.id = c.proyecto_id
      WHERE c.estado IN ('pendiente', 'parcial') ORDER BY c.fecha_vencimiento`,
  );
  const { rows: [mes] } = await pool.query(
    `SELECT COALESCE(sum(importe), 0) AS cobrado FROM pagos
      WHERE estado = 'confirmado' AND date_trunc('month', fecha_pago) = date_trunc('month', (now() AT TIME ZONE '${ZONA}')::date)`,
  );
  res.json({ success: true, data: { verificar, abiertos, cobrado_mes: mes.cobrado } });
};

// ── POST /admin/proyectos/:id/cobros { concepto, importe, fecha_vencimiento, hito_id? }
export const crearCobro = async (req, res) => {
  const pid = idDe(req.params.id, "Proyecto no encontrado.");
  const { rows: [p] } = await pool.query("SELECT * FROM proyectos WHERE id = $1", [pid]);
  if (!p) throw notFound("Proyecto no encontrado.");
  const { datos, errores } = v.aplicar(req.body, {
    concepto: (x) => v.texto(x, { max: 200, min: 3, requerido: true, nombre: "El concepto" }),
    importe: (x) => v.dinero(x, { nombre: "El importe" }) ?? (() => { throw "El importe es obligatorio."; })(),
    fecha_vencimiento: (x) => v.fecha(x) ?? (() => { throw "La fecha de pago es obligatoria."; })(),
    hito_id: (x) => v.entero(x, { min: 1, max: Number.MAX_SAFE_INTEGER, nombre: "El hito" }),
  });
  if (datos.importe === 0) errores.importe = "El importe debe ser mayor que cero.";
  if (Object.keys(errores).length) throw badRequest("Revisa los datos del cobro.", { errores });
  if (datos.hito_id) {
    const { rows } = await pool.query("SELECT 1 FROM proyecto_hitos WHERE id = $1 AND proyecto_id = $2", [datos.hito_id, p.id]);
    if (!rows[0]) throw badRequest("Ese hito no es de este proyecto.");
  }
  const cobro = await enTransaccion(async (db) => {
    const { rows: [c] } = await db.query(
      `INSERT INTO cobros (cliente_id, proyecto_id, hito_id, tipo, concepto, importe, moneda, fecha_vencimiento, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [p.cliente_id, p.id, datos.hito_id, datos.hito_id ? "hito" : "manual", datos.concepto, datos.importe, p.moneda, datos.fecha_vencimiento, req.actor.id],
    );
    await registrarActividad(db, {
      cliente_id: p.cliente_id, actor_id: req.actor.id, entidad: "cobro", entidad_id: c.id, accion: "cobro_creado",
      descripcion: `Nuevo cobro ${c.codigo}: ${c.concepto} · ${dinero(c.importe, c.moneda)} · pagar antes del ${fechaCorta(c.fecha_vencimiento)}`,
      visible_cliente: true,
    });
    return c;
  });
  res.status(201).json({ success: true, message: `Cobro ${cobro.codigo} creado.`, data: cobro });
};

// ── POST /admin/proyectos/:id/cobros/generar → mensualidades que tocan ya
export const generarAhora = async (req, res) => {
  const pid = idDe(req.params.id, "Proyecto no encontrado.");
  const n = await generarCobrosRecurrentes({ proyectoId: pid });
  res.json({ success: true, message: n ? `${n} cobro(s) generados.` : "No hay cobros nuevos por generar.", data: { creados: n } });
};

// ── POST /admin/cobros/:id/anular { motivo } ─────────────────────
export const anularCobro = async (req, res) => {
  const c = await cobroPorId(pool, req.params.id);
  if (c.estado === "anulado") throw conflict("El cobro ya está anulado.");
  const { rows: [{ n }] } = await pool.query(
    "SELECT count(*)::int AS n FROM pagos WHERE cobro_id = $1 AND estado IN ('confirmado', 'en_verificacion')",
    [c.id],
  );
  if (n) throw conflict("No se puede anular un cobro con pagos registrados o por verificar.");
  let motivo;
  try { motivo = v.texto(req.body?.motivo, { max: 300, min: 3, requerido: true, nombre: "El motivo" }); } catch (e) { throw errorCampo("motivo", e); }
  await enTransaccion(async (db) => {
    await db.query("UPDATE cobros SET estado = 'anulado', anulado_motivo = $2 WHERE id = $1", [c.id, motivo]);
    await registrarActividad(db, {
      cliente_id: c.cliente_id, actor_id: req.actor.id, entidad: "cobro", entidad_id: c.id, accion: "cobro_anulado",
      descripcion: `Cobro ${c.codigo} anulado: ${motivo}`, visible_cliente: true,
    });
  });
  res.json({ success: true, message: `Cobro ${c.codigo} anulado.` });
};

/** Inserta un pago confirmado del equipo y recalcula el cobro. */
async function registrarPagoEquipo(db, c, d, actor) {
  const { rows: [pg] } = await db.query(
    `INSERT INTO pagos (cobro_id, cliente_id, importe, moneda, fecha_pago, via, estado, referencia, notas,
                        registrado_por, confirmado_por, confirmado_en)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmado', $7, $8, $9, $9, now()) RETURNING *`,
    [c.id, c.cliente_id, d.importe, c.moneda, d.fecha_pago, d.via, d.referencia, d.notas, actor.id],
  );
  const nuevo = await recalcularCobro(db, c.id);
  await registrarActividad(db, {
    cliente_id: c.cliente_id, actor_id: actor.id, entidad: "pago", entidad_id: pg.id, accion: "pago_registrado",
    descripcion: `Pago de ${dinero(pg.importe, pg.moneda)} registrado para ${c.codigo} (${ETIQUETA_VIA[pg.via]}, ${fechaCorta(pg.fecha_pago)})`,
    visible_cliente: true,
  });
  return { pago: pg, cobro: nuevo };
}

// ── POST /admin/cobros/:id/pagos { fecha_pago, via, importe?, referencia?, notas? }
export const registrarPago = async (req, res) => {
  const c = await cobroPorId(pool, req.params.id);
  if (c.estado === "anulado") throw conflict("El cobro está anulado.");
  const { datos, errores } = v.aplicar(req.body, reglasPago);
  if (Object.keys(errores).length) throw badRequest("Revisa los datos del pago.", { errores });
  const r = await enTransaccion(async (db) => {
    await db.query("SELECT id FROM cobros WHERE id = $1 FOR UPDATE", [c.id]);
    const pendiente = await pendienteDe(db, c);
    if (pendiente <= 0) throw conflict("Este cobro ya está pagado (o tiene un comprobante por verificar).");
    const importe = datos.importe ?? pendiente;
    if (importe <= 0 || importe > pendiente) throw badRequest(`El importe debe ser mayor que 0 y no superar lo pendiente (${dinero(pendiente, c.moneda)}).`, { errores: { importe: "Importe no válido." } });
    return registrarPagoEquipo(db, c, { ...datos, importe }, req.actor);
  });
  res.status(201).json({ success: true, message: `Pago registrado. ${r.cobro.codigo}: ${r.cobro.estado}.`, data: r });
};

// ── POST /admin/cobros/pagar-lote { cobro_ids: [], via, referencia?, fecha: "vencimiento" | YYYY-MM-DD }
// Para cargar historial: marca varios cobros como pagados por su importe pendiente.
export const pagarLote = async (req, res) => {
  const ids = Array.isArray(req.body?.cobro_ids) ? [...new Set(req.body.cobro_ids.map(Number))] : [];
  if (!ids.length || ids.length > 200 || ids.some((x) => !Number.isInteger(x) || x <= 0)) throw badRequest("Elige entre 1 y 200 cobros.");
  let via, fecha, referencia;
  try {
    via = v.opcion(req.body?.via, VIAS, { requerido: true, nombre: "El medio de pago" });
    fecha = req.body?.fecha === "vencimiento" ? "vencimiento" : v.fecha(req.body?.fecha) ?? "vencimiento";
    referencia = v.texto(req.body?.referencia, { max: 120, nombre: "La referencia" });
  } catch (e) {
    throw badRequest(e);
  }
  const hechos = await enTransaccion(async (db) => {
    const lista = [];
    for (const id of ids) {
      const c = await cobroPorId(db, id);
      if (c.estado === "anulado") continue;
      await db.query("SELECT id FROM cobros WHERE id = $1 FOR UPDATE", [c.id]);
      const pendiente = await pendienteDe(db, c);
      if (pendiente <= 0) continue;
      const fechaPago = fecha === "vencimiento" ? c.fecha_vencimiento : fecha;
      lista.push((await registrarPagoEquipo(db, c, { importe: pendiente, via, referencia, notas: null, fecha_pago: fechaPago }, req.actor)).cobro.codigo);
    }
    return lista;
  });
  res.json({ success: true, message: hechos.length ? `${hechos.length} cobro(s) marcados como pagados.` : "No había nada pendiente en esos cobros.", data: { cobros: hechos } });
};

async function pagoPorId(db, id) {
  const { rows: [pg] } = await db.query(
    `SELECT pg.*, c.codigo AS cobro_codigo, c.concepto, c.cliente_id AS cobro_cliente_id, a.s3_clave, a.nombre_original, a.mime
       FROM pagos pg JOIN cobros c ON c.id = pg.cobro_id LEFT JOIN archivos a ON a.id = pg.comprobante_archivo_id
      WHERE pg.id = $1`,
    [idDe(id, "Pago no encontrado.")],
  );
  if (!pg) throw notFound("Pago no encontrado.");
  return pg;
}

// ── POST /admin/pagos/:id/confirmar { importe?, fecha_pago?, via?, referencia? }
// El equipo puede corregir los datos leídos antes de confirmar.
export const confirmarPago = async (req, res) => {
  const pg = await pagoPorId(pool, req.params.id);
  if (pg.estado !== "en_verificacion") throw conflict("Este pago ya fue revisado.");
  const { datos, errores } = v.aplicar(req.body ?? {}, reglasPago, { parcial: true });
  if (Object.keys(errores).length) throw badRequest("Revisa los datos del pago.", { errores });
  const r = await enTransaccion(async (db) => {
    const cambios = Object.fromEntries(Object.entries(datos).filter(([, val]) => val != null));
    const claves = Object.keys(cambios);
    const { rows: [nuevo] } = await db.query(
      `UPDATE pagos SET estado = 'confirmado', confirmado_por = $2, confirmado_en = now()
              ${claves.map((k, i) => `, ${k} = $${i + 3}`).join("")}
        WHERE id = $1 AND estado = 'en_verificacion' RETURNING *`,
      [pg.id, req.actor.id, ...claves.map((k) => cambios[k])],
    );
    if (!nuevo) throw conflict("Este pago ya fue revisado.");
    const cobro = await recalcularCobro(db, pg.cobro_id);
    await registrarActividad(db, {
      cliente_id: pg.cliente_id, actor_id: req.actor.id, entidad: "pago", entidad_id: pg.id, accion: "pago_confirmado",
      descripcion: `Pago de ${dinero(nuevo.importe, nuevo.moneda)} confirmado para ${cobro.codigo}`, visible_cliente: true,
    });
    return { pago: nuevo, cobro };
  });
  avisarResultadoPago(r.pago, r.cobro, { confirmado: true }).catch((e) => console.error("❌ Aviso de pago:", e.message));
  res.json({ success: true, message: `Pago confirmado. ${r.cobro.codigo}: ${r.cobro.estado}.`, data: r });
};

// ── POST /admin/pagos/:id/rechazar { motivo } ────────────────────
export const rechazarPago = async (req, res) => {
  const pg = await pagoPorId(pool, req.params.id);
  if (pg.estado !== "en_verificacion") throw conflict("Este pago ya fue revisado.");
  let motivo;
  try { motivo = v.texto(req.body?.motivo, { max: 300, min: 3, requerido: true, nombre: "El motivo" }); } catch (e) { throw errorCampo("motivo", e); }
  const r = await enTransaccion(async (db) => {
    const { rows: [nuevo] } = await db.query(
      "UPDATE pagos SET estado = 'rechazado', rechazo_motivo = $2, confirmado_por = $3, confirmado_en = now() WHERE id = $1 AND estado = 'en_verificacion' RETURNING *",
      [pg.id, motivo, req.actor.id],
    );
    if (!nuevo) throw conflict("Este pago ya fue revisado.");
    const cobro = await recalcularCobro(db, pg.cobro_id);
    await registrarActividad(db, {
      cliente_id: pg.cliente_id, actor_id: req.actor.id, entidad: "pago", entidad_id: pg.id, accion: "pago_rechazado",
      descripcion: `Comprobante de ${cobro.codigo} no confirmado: ${motivo}`, visible_cliente: true,
    });
    return { pago: nuevo, cobro };
  });
  avisarResultadoPago(r.pago, r.cobro, { confirmado: false, motivo }).catch((e) => console.error("❌ Aviso de pago:", e.message));
  res.json({ success: true, message: "Pago rechazado; el cliente fue avisado.", data: r });
};

// ── POST /admin/pagos/:id/comprobante (cuerpo crudo: imagen o PDF) ─
export const adjuntarComprobanteEquipo = async (req, res) => {
  const pg = await pagoPorId(pool, req.params.id);
  const anterior = pg.s3_clave;
  await enTransaccion(async (db) => {
    const { archivoId } = await guardarComprobante(db, { buf: req.body, clienteId: pg.cliente_id, actorId: req.actor.id, nombre: req.query.nombre });
    await db.query("UPDATE pagos SET comprobante_archivo_id = $2 WHERE id = $1", [pg.id, archivoId]);
    if (pg.comprobante_archivo_id) await db.query("DELETE FROM archivos WHERE id = $1", [pg.comprobante_archivo_id]);
    await registrarActividad(db, {
      cliente_id: pg.cliente_id, actor_id: req.actor.id, entidad: "pago", entidad_id: pg.id, accion: "comprobante_adjuntado",
      descripcion: `${nombreCorto(req.actor)} adjuntó el comprobante del pago de ${pg.cobro_codigo}`, visible_cliente: true,
    });
  });
  if (anterior) await almacen.borrar(anterior).catch(() => {});
  res.json({ success: true, message: "Comprobante adjuntado." });
};

// ── GET /admin/pagos/:id/comprobante → { url } ───────────────────
export const verComprobanteEquipo = async (req, res) => {
  const pg = await pagoPorId(pool, req.params.id);
  if (!pg.s3_clave) throw notFound("Este pago no tiene comprobante.");
  res.json({ success: true, data: { url: await almacen.urlFirmada(pg.s3_clave, { nombre: pg.nombre_original, contentType: pg.mime }) } });
};

// ═════════════════════════ Cliente ══════════════════════════════

async function miCliente(req) {
  const c = await clienteDeUsuario(req.actor.id);
  if (!c) throw notFound("Tu cuenta aún no tiene ficha de cliente.");
  return c;
}

// ── GET /cobros/mios → { cuenta, cobros } ────────────────────────
export const misCobros = async (req, res) => {
  const cliente = await clienteDeUsuario(req.actor.id);
  if (!cliente) return res.json({ success: true, data: { cuenta: null, cobros: [] } });
  res.json({
    success: true,
    data: {
      cuenta: await estadoCuenta(pool, cliente.id),
      cobros: await cobrosDe(pool, { clienteId: cliente.id, paraCliente: true }),
      mercadopago: mpConfigurado(),
    },
  });
};

// ── POST /cobros/mios/:codigo/mercadopago → { url } de Checkout Pro ─
export const pagarConMercadoPago = async (req, res) => {
  if (!mpConfigurado()) throw new HttpError(503, "El pago con Mercado Pago no está disponible por ahora.");
  const cliente = await miCliente(req);
  const codigo = String(req.params.codigo ?? "").toUpperCase().slice(0, 12);
  const { rows: [c] } = await pool.query("SELECT * FROM cobros WHERE codigo = $1 AND cliente_id = $2", [codigo, cliente.id]);
  if (!c) throw notFound("Cobro no encontrado.");
  if (!["pendiente", "parcial"].includes(c.estado)) throw conflict("Este cobro no tiene nada pendiente.");
  const pendiente = await pendienteDe(pool, c);
  if (pendiente <= 0) throw conflict("Ya hay un comprobante por verificar para este cobro.");
  const vuelta = `${FRONTEND_URL}/area-cliente?seccion=pagos&cobro=${encodeURIComponent(c.codigo)}&mp=1`;
  const pref = await mp.crearPreferencia({
    cobro: c,
    importe: pendiente,
    pagador: { email: cliente.email_facturacion || cliente.email, nombre: cliente.nombre },
    urlVuelta: vuelta,
    urlWebhook: `${API_PUBLIC_URL}/webhooks/mercadopago`,
  });
  res.json({ success: true, data: { url: pref.url, prueba: mp.modoPrueba() } });
};

// ── POST /webhooks/mercadopago?type=payment&data.id=… (público, firmado) ─
// Responde 200 a lo que no le interesa para que MP no reintente; 401 si la firma no cuadra.
export const webhookMercadoPago = async (req, res) => {
  const tipo = req.query.type ?? req.query.topic ?? req.body?.type;
  const dataId = req.query["data.id"] ?? req.body?.data?.id ?? req.query.id;
  if (tipo !== "payment" || !dataId) return res.json({ ok: true, ignorado: true });
  if (!mp.firmaValida({ firma: req.get("x-signature"), requestId: req.get("x-request-id"), dataId })) {
    console.warn(`⚠️  Webhook de Mercado Pago con firma no válida (data.id=${String(dataId).slice(0, 30)}).`);
    return res.status(401).json({ success: false, error: "Firma no válida." });
  }

  const pagoMp = await mp.obtenerPago(dataId);
  if (pagoMp.status !== "approved") {
    console.log(`💳 Mercado Pago ${pagoMp.id}: ${pagoMp.status} (${pagoMp.status_detail ?? ""}).`);
    return res.json({ ok: true, estado: pagoMp.status });
  }
  const cobroId = Number(String(pagoMp.external_reference ?? "").match(/^cobro:(\d+)$/)?.[1]);
  const { rows: [c] } = cobroId ? await pool.query("SELECT * FROM cobros WHERE id = $1", [cobroId]) : { rows: [] };
  if (!c) {
    console.error(`🚨 Mercado Pago ${pagoMp.id} aprobado sin cobro reconocible (ref ${pagoMp.external_reference}).`);
    return res.json({ ok: true, sin_cobro: true });
  }
  if ((pagoMp.currency_id ?? "COP") !== c.moneda) {
    console.error(`🚨 Mercado Pago ${pagoMp.id}: moneda ${pagoMp.currency_id} distinta de ${c.moneda} (${c.codigo}).`);
    return res.json({ ok: true, moneda_distinta: true });
  }
  const importe = Number(pagoMp.transaction_amount);
  const fecha = String(pagoMp.date_approved ?? pagoMp.date_created ?? new Date().toISOString()).slice(0, 10);

  const r = await enTransaccion(async (db) => {
    const { rows: [pg] } = await db.query(
      `INSERT INTO pagos (cobro_id, cliente_id, importe, moneda, fecha_pago, via, estado, referencia, mp_payment_id, confirmado_en)
       VALUES ($1, $2, $3, $4, $5, 'mercadopago', 'confirmado', $6, $6, now())
       ON CONFLICT (mp_payment_id) DO NOTHING RETURNING *`,
      [c.id, c.cliente_id, importe, c.moneda, fecha, String(pagoMp.id)],
    );
    if (!pg) return null; // notificación repetida
    const cobro = await recalcularCobro(db, c.id);
    await registrarActividad(db, {
      cliente_id: c.cliente_id, entidad: "pago", entidad_id: pg.id, accion: "pago_mercadopago",
      descripcion: `Pago de ${dinero(importe, c.moneda)} recibido por Mercado Pago para ${c.codigo}`, visible_cliente: true,
    });
    return { pago: pg, cobro };
  });
  if (r) {
    avisarResultadoPago(r.pago, r.cobro, { confirmado: true }).catch((e) => console.error("❌ Aviso de pago:", e.message));
    avisarPagoMercadoPago(r.pago, r.cobro).catch((e) => console.error("❌ Aviso de pago:", e.message));
  }
  res.json({ ok: true });
};

// ── POST /cobros/mios/:codigo/comprobante?fecha=&via=&referencia=&nombre=
// Cuerpo crudo: el comprobante. Crea un pago "en verificación" por lo pendiente.
export const subirComprobanteCobro = async (req, res) => {
  const cliente = await miCliente(req);
  const codigo = String(req.params.codigo ?? "").toUpperCase().slice(0, 12);
  const { rows: [c] } = await pool.query("SELECT * FROM cobros WHERE codigo = $1 AND cliente_id = $2", [codigo, cliente.id]);
  if (!c) throw notFound("Cobro no encontrado.");
  if (!["pendiente", "parcial"].includes(c.estado)) throw conflict("Este cobro no tiene nada pendiente.");
  const { datos, errores } = v.aplicar(
    { fecha_pago: req.query.fecha, via: req.query.via, referencia: req.query.referencia },
    {
      fecha_pago: (x) => v.fecha(x),
      via: (x) => v.opcion(x, VIAS.filter((y) => y !== "mercadopago"), { requerido: true, nombre: "El medio de pago" }),
      referencia: reglasPago.referencia,
    },
  );
  if (Object.keys(errores).length) throw badRequest("Revisa los datos del pago.", { errores });

  let subida;
  const r = await enTransaccion(async (db) => {
    await db.query("SELECT id FROM cobros WHERE id = $1 FOR UPDATE", [c.id]);
    const pendiente = await pendienteDe(db, c);
    if (pendiente <= 0) throw conflict("Ya hay un comprobante por verificar para este cobro.");
    subida = await guardarComprobante(db, { buf: req.body, clienteId: cliente.id, actorId: req.actor.id, nombre: req.query.nombre });
    const { rows: [pg] } = await db.query(
      `INSERT INTO pagos (cobro_id, cliente_id, importe, moneda, fecha_pago, via, estado, referencia, comprobante_archivo_id, registrado_por)
       VALUES ($1, $2, $3, $4, COALESCE($5, (now() AT TIME ZONE '${ZONA}')::date), $6, 'en_verificacion', $7, $8, $9) RETURNING *`,
      [c.id, cliente.id, pendiente, c.moneda, datos.fecha_pago, datos.via, datos.referencia, subida.archivoId, req.actor.id],
    );
    await registrarActividad(db, {
      cliente_id: cliente.id, actor_id: req.actor.id, entidad: "pago", entidad_id: pg.id, accion: "comprobante_subido",
      descripcion: `Enviaste el comprobante de ${c.codigo} (${dinero(pg.importe, pg.moneda)}); lo estamos verificando`, visible_cliente: true,
    });
    return pg;
  }).catch(async (e) => {
    if (subida) await almacen.borrar(subida.clave).catch(() => {});
    throw e;
  });
  // En segundo plano: lectura con IA (si está configurada) y aviso al equipo con lo leído.
  const buf = req.body;
  (async () => {
    const lectura = await leerYGuardar(r, c, { buf, mime: subida.mime });
    await avisarComprobante(r, c, lectura);
  })().catch((e) => console.error("❌ Aviso de comprobante:", e.message));
  res.status(201).json({ success: true, message: "Recibimos tu comprobante. Te avisaremos cuando lo confirmemos.", data: { id: r.id } });
};

/** Lee el comprobante con IA, lo contrasta con el cobro y guarda la lectura en el pago. */
async function leerYGuardar(pago, cobro, archivo) {
  const lectura = await leerComprobante(archivo);
  if (!lectura) return null;
  const { rows: [dup] } = lectura.referencia
    ? await pool.query(
        `SELECT 1 FROM pagos WHERE id <> $1 AND estado <> 'rechazado'
            AND (referencia = $2 OR lectura_ia->>'referencia' = $2) LIMIT 1`,
        [pago.id, lectura.referencia],
      )
    : { rows: [] };
  const { rows: [desde] } = await pool.query("SELECT ($1::date - 45)::text AS d", [cobro.fecha_vencimiento]);
  const completa = { ...lectura, contraste: contrastar(lectura, { pendiente: Number(pago.importe), emitido: desde.d, duplicado: Boolean(dup) }) };
  await pool.query(
    "UPDATE pagos SET lectura_ia = $2, referencia = COALESCE(referencia, $3) WHERE id = $1",
    [pago.id, completa, lectura.referencia?.slice(0, 120) ?? null],
  );
  return completa;
}

/** Pago del cliente de esta cuenta. */
async function miPago(req) {
  const cliente = await miCliente(req);
  const pg = await pagoPorId(pool, req.params.id);
  if (String(pg.cliente_id) !== String(cliente.id)) throw notFound("Pago no encontrado.");
  return pg;
}

// ── POST /pagos/:id/comprobante → adjuntar a un pago propio sin comprobante
export const adjuntarComprobanteCliente = async (req, res) => {
  const pg = await miPago(req);
  if (pg.comprobante_archivo_id) throw conflict("Este pago ya tiene comprobante.");
  if (pg.estado === "rechazado") throw conflict("Este pago fue rechazado; sube un comprobante nuevo desde el cobro.");
  let subida;
  await enTransaccion(async (db) => {
    subida = await guardarComprobante(db, { buf: req.body, clienteId: pg.cliente_id, actorId: req.actor.id, nombre: req.query.nombre });
    const { rowCount } = await db.query(
      "UPDATE pagos SET comprobante_archivo_id = $2 WHERE id = $1 AND comprobante_archivo_id IS NULL",
      [pg.id, subida.archivoId],
    );
    if (!rowCount) throw conflict("Este pago ya tiene comprobante.");
    await registrarActividad(db, {
      cliente_id: pg.cliente_id, actor_id: req.actor.id, entidad: "pago", entidad_id: pg.id, accion: "comprobante_adjuntado",
      descripcion: `Adjuntaste el comprobante del pago de ${pg.cobro_codigo}`, visible_cliente: true,
    });
  }).catch(async (e) => {
    if (subida) await almacen.borrar(subida.clave).catch(() => {});
    throw e;
  });
  res.json({ success: true, message: "Comprobante adjuntado." });
};

// ── GET /pagos/:id/comprobante → { url } ─────────────────────────
export const verComprobanteCliente = async (req, res) => {
  const pg = await miPago(req);
  if (!pg.s3_clave) throw notFound("Este pago no tiene comprobante.");
  res.json({ success: true, data: { url: await almacen.urlFirmada(pg.s3_clave, { nombre: pg.nombre_original, contentType: pg.mime }) } });
};
