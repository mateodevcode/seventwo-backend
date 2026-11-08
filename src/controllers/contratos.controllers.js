// src/controllers/contratos.controllers.js — contratos (F2 de docs/CLIENTES.md).
// Equipo: subir versión (borrador o ya firmada fuera), enviar, borrar borrador, ver.
// Cliente: ver los suyos (nunca borradores) y aceptarlos dejando evidencia.
import { enTransaccion, pool } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import * as almacen from "../lib/almacen.js";
import * as v from "../lib/validar.js";
import { clienteDeUsuario, registrarActividad } from "../services/clientes.service.js";
import {
  MAX_PDF,
  avisarContratoAceptado,
  avisarContratoEnviado,
  avisarContratoFirmadoFuera,
  contratoCompleto,
  esPdf,
  nombreArchivo,
  reemplazarVigente,
} from "../services/contratos.service.js";

const nombreCorto = (actor) => actor.name.split(" ")[0];

async function proyectoDe(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw notFound("Proyecto no encontrado.");
  const { rows: [p] } = await pool.query("SELECT id, codigo, nombre, cliente_id FROM proyectos WHERE id = $1", [n]);
  if (!p) throw notFound("Proyecto no encontrado.");
  return p;
}

// ═════════════════════════ Equipo ═══════════════════════════════

// ── POST /admin/proyectos/:id/contratos?titulo=&nombre=&firmado_fuera=1
//    Cuerpo: el PDF crudo (Content-Type: application/pdf, máx. 10 MB).
export const subirContrato = async (req, res) => {
  const p = await proyectoDe(req.params.id);
  const pdf = req.body;
  if (!Buffer.isBuffer(pdf) || !pdf.length) throw badRequest("Adjunta el contrato en PDF.");
  if (pdf.length > MAX_PDF) throw badRequest("El PDF supera los 10 MB.");
  if (!esPdf(pdf)) throw badRequest("El archivo no es un PDF válido.");

  let titulo;
  try {
    titulo = v.texto(req.query.titulo, { max: 160, min: 3, requerido: true, nombre: "El título" });
  } catch (e) {
    throw badRequest(e, { errores: { titulo: e } });
  }
  const firmadoFuera = req.query.firmado_fuera === "1";
  const nombre = nombreArchivo(req.query.nombre);

  // Primero a S3 (fuera de la transacción); si la BD falla, se borra.
  const subido = await almacen.subir({
    clave: almacen.clavePrivada(`contratos/${p.cliente_id}`, "pdf"),
    body: pdf,
    contentType: "application/pdf",
  });

  try {
    const contrato = await enTransaccion(async (db) => {
      const { rows: [a] } = await db.query(
        `INSERT INTO archivos (cliente_id, subido_por, nombre_original, mime, bytes, sha256, s3_clave)
         VALUES ($1, $2, $3, 'application/pdf', $4, $5, $6) RETURNING id`,
        [p.cliente_id, req.actor.id, nombre, subido.bytes, subido.sha256, subido.clave],
      );
      // Bloqueo del proyecto para numerar versiones sin carreras.
      await db.query("SELECT id FROM proyectos WHERE id = $1 FOR UPDATE", [p.id]);
      const { rows: [{ siguiente }] } = await db.query(
        "SELECT COALESCE(max(version), 0) + 1 AS siguiente FROM contratos WHERE proyecto_id = $1",
        [p.id],
      );
      if (firmadoFuera) await reemplazarVigente(db, p.id);
      const { rows: [c] } = await db.query(
        `INSERT INTO contratos (proyecto_id, version, titulo, archivo_id, sha256, estado, creado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [p.id, siguiente, titulo, a.id, subido.sha256, firmadoFuera ? "firmado_fuera" : "borrador", req.actor.id],
      );
      await registrarActividad(db, {
        cliente_id: p.cliente_id, actor_id: req.actor.id, entidad: "contrato", entidad_id: c.id,
        accion: firmadoFuera ? "contrato_firmado_fuera" : "contrato_borrador",
        descripcion: firmadoFuera
          ? `Contrato firmado de ${p.codigo} archivado: ${titulo} (v${siguiente})`
          : `${nombreCorto(req.actor)} subió el borrador v${siguiente} del contrato de ${p.codigo}`,
        visible_cliente: firmadoFuera,
      });
      return contratoCompleto(db, c.id);
    });
    if (firmadoFuera) avisarContratoFirmadoFuera(contrato).catch((e) => console.error("❌ Aviso de contrato firmado:", e.message));
    res.status(201).json({
      success: true,
      message: firmadoFuera ? `Contrato firmado v${contrato.version} archivado.` : `Borrador v${contrato.version} subido. Revísalo y envíalo al cliente.`,
      data: { id: contrato.id, version: contrato.version, estado: contrato.estado },
    });
  } catch (e) {
    await almacen.borrar(subido.clave).catch(() => {});
    throw e;
  }
};

// ── POST /admin/contratos/:id/enviar { nota? } ───────────────────
export const enviarContrato = async (req, res) => {
  const c = await contratoCompleto(pool, req.params.id);
  if (!c) throw notFound("Contrato no encontrado.");
  if (c.estado !== "borrador") throw conflict("Solo se puede enviar un borrador.");
  let nota;
  try {
    nota = v.parrafo(req.body?.nota, { max: 1000, nombre: "La nota" });
  } catch (e) {
    throw badRequest(e, { errores: { nota: e } });
  }

  const enviado = await enTransaccion(async (db) => {
    const anterior = await reemplazarVigente(db, c.proyecto_id, c.id);
    await db.query(
      "UPDATE contratos SET estado = 'enviado', enviado_en = now(), enviado_por = $2, nota = $3 WHERE id = $1",
      [c.id, req.actor.id, nota],
    );
    await registrarActividad(db, {
      cliente_id: c.cliente_id, actor_id: req.actor.id, entidad: "contrato", entidad_id: c.id,
      accion: "contrato_enviado",
      descripcion: `Contrato de ${c.proyecto_codigo} enviado para aceptar: ${c.titulo} (v${c.version})${anterior ? ` · reemplaza a la v${anterior}` : ""}`,
      visible_cliente: true,
    });
    return contratoCompleto(db, c.id);
  });
  avisarContratoEnviado(enviado).catch((e) => console.error("❌ Aviso de contrato enviado:", e.message));
  res.json({ success: true, message: `Contrato v${c.version} enviado a ${c.cliente_nombre}.` });
};

// ── DELETE /admin/contratos/:id (solo borradores) ────────────────
export const borrarBorrador = async (req, res) => {
  const c = await contratoCompleto(pool, req.params.id);
  if (!c) throw notFound("Contrato no encontrado.");
  if (c.estado !== "borrador") throw conflict("Solo se pueden borrar borradores; las versiones enviadas quedan en el historial.");
  await enTransaccion(async (db) => {
    await db.query("DELETE FROM contratos WHERE id = $1", [c.id]);
    await db.query("DELETE FROM archivos WHERE id = $1", [c.archivo_id]);
  });
  await almacen.borrar(c.s3_clave).catch((e) => console.error("❌ No se pudo borrar de S3:", c.s3_clave, e.message));
  res.json({ success: true, message: `Borrador v${c.version} eliminado.` });
};

// ── GET /admin/contratos/:id/archivo → { url } (firmada, 5 min) ──
export const archivoAdmin = async (req, res) => {
  const c = await contratoCompleto(pool, req.params.id);
  if (!c) throw notFound("Contrato no encontrado.");
  res.json({ success: true, data: { url: await almacen.urlFirmada(c.s3_clave, { nombre: c.archivo_nombre }) } });
};

// ═════════════════════════ Cliente ══════════════════════════════

/** El contrato si es de un proyecto del cliente de esta cuenta y no es borrador. */
async function contratoMio(req) {
  const cliente = await clienteDeUsuario(req.actor.id);
  const c = cliente ? await contratoCompleto(pool, req.params.id) : null;
  if (!c || c.cliente_id !== cliente.id || c.estado === "borrador") throw notFound("Contrato no encontrado.");
  return c;
}

// ── GET /contratos/:id/archivo → { url } ─────────────────────────
export const archivoCliente = async (req, res) => {
  const c = await contratoMio(req);
  res.json({ success: true, data: { url: await almacen.urlFirmada(c.s3_clave, { nombre: c.archivo_nombre }) } });
};

// ── POST /contratos/:id/aceptar { nombre, acepto: true } ─────────
export const aceptarContrato = async (req, res) => {
  const c = await contratoMio(req);
  if (c.estado !== "enviado") {
    throw conflict(c.estado === "aceptado" ? "Ya aceptaste este contrato." : "Esta versión del contrato ya no está vigente.");
  }
  let nombre;
  try {
    nombre = v.texto(req.body?.nombre, { max: 160, min: 5, requerido: true, nombre: "Tu nombre completo" });
  } catch (e) {
    throw badRequest(e, { errores: { nombre: e } });
  }
  if (req.body?.acepto !== true) throw badRequest("Marca la casilla para aceptar el contrato.", { errores: { acepto: "Obligatorio." } });

  // Evidencia: el archivo guardado sigue siendo exactamente el que se envió.
  const actual = await almacen.sha256Guardado(c.s3_clave);
  if (actual !== c.sha256) {
    console.error(`🚨 Contrato ${c.id}: la huella del archivo no coincide (esperada ${c.sha256}, actual ${actual}).`);
    throw conflict("No pudimos verificar el documento. El equipo ya fue avisado; inténtalo más tarde.");
  }

  const ua = String(req.get("user-agent") ?? "").slice(0, 255) || null;
  const aceptado = await enTransaccion(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE contratos SET estado = 'aceptado', aceptado_en = now(), aceptado_por = $2,
              aceptado_nombre = $3, aceptado_ip = $4, aceptado_ua = $5
        WHERE id = $1 AND estado = 'enviado'`,
      [c.id, req.actor.id, nombre, req.ip ?? null, ua],
    );
    if (!rowCount) throw conflict("Esta versión del contrato ya no está vigente.");
    await registrarActividad(db, {
      cliente_id: c.cliente_id, actor_id: req.actor.id, entidad: "contrato", entidad_id: c.id,
      accion: "contrato_aceptado",
      descripcion: `Aceptaste el contrato de ${c.proyecto_codigo}: ${c.titulo} (v${c.version})`,
      datos: { nombre, sha256: c.sha256 }, visible_cliente: true,
    });
    const fila = await contratoCompleto(db, c.id);
    return { ...fila, aceptado_ip: req.ip ?? null };
  });
  avisarContratoAceptado(aceptado).catch((e) => console.error("❌ Aviso de contrato aceptado:", e.message));
  res.json({ success: true, message: "Contrato aceptado. Queda registrado con la fecha y tu nombre." });
};
