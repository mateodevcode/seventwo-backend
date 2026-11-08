// src/services/contratos.service.js — contratos de proyecto (docs/CLIENTES.md §3.8, F2).
import { pool } from "../db.js";
import { EQUIPO_EMAIL, FRONTEND_URL } from "../config.js";
import * as plantillas from "../emails/contratos.js";
import { escapeTg } from "../lib/telegram.js";
import { equipo, notificarEnSegundoPlano } from "./notificaciones.service.js";
import { rutaProyectoCliente } from "./clientes.service.js";

export const ESTADOS_CONTRATO = ["borrador", "enviado", "aceptado", "firmado_fuera", "reemplazado"];
export const VIGENTES = ["enviado", "aceptado", "firmado_fuera"];
export const MAX_PDF = 10 * 1024 * 1024;

export const rutaProyectoAdmin = (clienteId, proyectoId) => `/admin?seccion=clientes&cliente=${clienteId}&proyecto=${proyectoId}`;
const abs = (ruta) => `${FRONTEND_URL}${ruta}`;

/** ¿Es un PDF de verdad? (cabecera %PDF-, no solo la extensión ni el Content-Type) */
export const esPdf = (buf) => Buffer.isBuffer(buf) && buf.length > 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-";

/** Nombre de archivo seguro para mostrar y para Content-Disposition. */
export function nombreArchivo(n, porDefecto = "contrato.pdf") {
  const s = String(n ?? "").normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 150);
  if (!s) return porDefecto;
  return /\.pdf$/i.test(s) ? s : `${s}.pdf`;
}

/** Contratos de un proyecto. El cliente no ve los borradores. */
export async function contratosDe(db, proyectoId, { paraCliente = false } = {}) {
  const { rows } = await db.query(
    `SELECT c.id, c.version, c.titulo, c.nota, c.estado, c.sha256, c.created_at, c.enviado_en,
            c.aceptado_en, c.aceptado_nombre, c.reemplazado_en,
            a.nombre_original AS archivo_nombre, a.bytes AS archivo_bytes
            ${paraCliente ? "" : ", host(c.aceptado_ip) AS aceptado_ip, c.aceptado_ua, cr.name AS creado_por_nombre, ev.name AS enviado_por_nombre"}
       FROM contratos c
       JOIN archivos a ON a.id = c.archivo_id
       ${paraCliente ? "" : "LEFT JOIN usuarios cr ON cr.id = c.creado_por LEFT JOIN usuarios ev ON ev.id = c.enviado_por"}
      WHERE c.proyecto_id = $1 ${paraCliente ? "AND c.estado <> 'borrador'" : ""}
      ORDER BY c.version DESC`,
    [proyectoId],
  );
  return rows;
}

/** Contrato con su proyecto, cliente y archivo (para permisos y avisos). */
export async function contratoCompleto(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const { rows: [c] } = await db.query(
    `SELECT c.*, p.codigo AS proyecto_codigo, p.nombre AS proyecto_nombre, p.cliente_id,
            cl.usuario_id AS cliente_usuario_id, cl.email AS cliente_email, cl.nombre AS cliente_nombre,
            a.s3_clave, a.nombre_original AS archivo_nombre, a.mime AS archivo_mime
       FROM contratos c
       JOIN proyectos p ON p.id = c.proyecto_id
       JOIN clientes cl ON cl.id = p.cliente_id
       JOIN archivos a ON a.id = c.archivo_id
      WHERE c.id = $1`,
    [n],
  );
  return c ?? null;
}

/** Marca como reemplazada la versión vigente del proyecto (si hay). */
export async function reemplazarVigente(db, proyectoId, exceptoId = 0) {
  const { rows } = await db.query(
    `UPDATE contratos SET estado = 'reemplazado', reemplazado_en = now()
      WHERE proyecto_id = $1 AND estado = ANY($2) AND id <> $3 RETURNING version`,
    [proyectoId, VIGENTES, exceptoId],
  );
  return rows[0]?.version ?? null;
}

async function cuentaCliente(usuarioId) {
  if (!usuarioId) return null;
  const { rows } = await pool.query("SELECT id, socket_id, name FROM usuarios WHERE id = $1 AND NOT bloqueado", [usuarioId]);
  return rows[0] ?? null;
}

const urlRegistro = (email, ruta) => abs(`/registro?email=${encodeURIComponent(email)}&next=${encodeURIComponent(ruta)}`);

// ── Avisos ───────────────────────────────────────────────────────

export async function avisarContratoEnviado(c) {
  const cuenta = await cuentaCliente(c.cliente_usuario_id);
  const ruta = rutaProyectoCliente(c.proyecto_codigo);
  const cta = cuenta
    ? { urlCta: abs(ruta), textoCta: "Leer y aceptar el contrato" }
    : { urlCta: urlRegistro(c.cliente_email, ruta), textoCta: "Crea tu cuenta para leerlo" };
  notificarEnSegundoPlano({
    usuarios: cuenta ? [cuenta] : [],
    tipo: "contrato_enviado",
    titulo: `Contrato de ${c.proyecto_codigo} listo para aceptar`,
    cuerpo: `${c.titulo} · versión ${c.version}`,
    url: ruta,
    datos: { codigo: c.proyecto_codigo, contrato_id: c.id },
    email: {
      to: c.cliente_email,
      replyTo: EQUIPO_EMAIL,
      ...plantillas.contratoEnviado({
        name: cuenta?.name ?? c.cliente_nombre, codigo: c.proyecto_codigo, proyecto: c.proyecto_nombre,
        titulo: c.titulo, version: c.version, nota: c.nota, ...cta,
      }),
    },
  });
}

/** Contrato firmado fuera de la app y subido por el equipo: solo aviso in-app. */
export async function avisarContratoFirmadoFuera(c) {
  const cuenta = await cuentaCliente(c.cliente_usuario_id);
  if (!cuenta) return;
  notificarEnSegundoPlano({
    usuarios: [cuenta],
    tipo: "contrato_firmado",
    titulo: `Contrato firmado de ${c.proyecto_codigo} disponible`,
    cuerpo: c.titulo,
    url: rutaProyectoCliente(c.proyecto_codigo),
    datos: { codigo: c.proyecto_codigo, contrato_id: c.id },
  });
}

export async function avisarContratoAceptado(c) {
  const ruta = rutaProyectoAdmin(c.cliente_id, c.proyecto_id);
  const fecha = new Date(c.aceptado_en).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "long", timeStyle: "short" });
  notificarEnSegundoPlano({
    usuarios: await equipo(),
    tipo: "contrato_aceptado",
    titulo: `${c.cliente_nombre} aceptó el contrato de ${c.proyecto_codigo}`,
    cuerpo: `${c.titulo} · v${c.version}`,
    url: ruta,
    datos: { proyecto_id: c.proyecto_id, contrato_id: c.id },
    email: {
      to: EQUIPO_EMAIL,
      replyTo: c.cliente_email,
      ...plantillas.contratoAceptado({
        cliente: c.cliente_nombre, codigo: c.proyecto_codigo, proyecto: c.proyecto_nombre, titulo: c.titulo,
        version: c.version, nombre: c.aceptado_nombre, fecha, ip: c.aceptado_ip ?? "—", url: abs(ruta),
      }),
    },
    telegram: {
      html: `✍️ <b>${escapeTg(c.cliente_nombre)}</b> aceptó el contrato de <b>${escapeTg(c.proyecto_codigo)}</b>\n📄 ${escapeTg(c.titulo)} · v${c.version}\n🕒 ${escapeTg(fecha)}`,
      boton: { texto: "Abrir el proyecto", url: abs(ruta) },
    },
  });
}
