// src/controllers/solicitudes.controllers.js — formulario público y "Mis solicitudes".
// IDOR: las rutas /mias/* filtran SIEMPRE por usuario_id = token, nunca por un
// email o id que llegue del cliente.
import { pool } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { emailValido, normalizarEmail } from "../validations/auth.validate.js";
import {
  RANGOS_PRESUPUESTO,
  TIPOS_PROYECTO,
  avisarClienteRespondio,
  avisarSolicitudNueva,
} from "../services/solicitudes.service.js";

const TIEMPO_MINIMO_MS = 3000; // los humanos tardan más de 3 s en llenar el formulario
const texto = (v, max) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

function validar(body, { conSesion }) {
  const nombre = texto(body.nombre, 100);
  const email = normalizarEmail(body.email);
  const telefono = texto(body.telefono, 20);
  const empresa = texto(body.empresa, 120);
  const tipo = texto(body.tipo_proyecto, 40);
  const presupuesto = texto(body.presupuesto, 40);
  const descripcion = typeof body.descripcion === "string" ? body.descripcion.trim().slice(0, 3000) : "";

  if (!conSesion) {
    if (nombre.length < 2) throw badRequest("Escribe tu nombre.");
    if (!emailValido(email)) throw badRequest("El email no es válido.");
  }
  if (telefono && !/^\+?[\d\s().-]{7,20}$/.test(telefono)) throw badRequest("El teléfono no es válido.");
  if (!TIPOS_PROYECTO.includes(tipo)) throw badRequest("Elige un tipo de proyecto.");
  if (presupuesto && !RANGOS_PRESUPUESTO.includes(presupuesto)) throw badRequest("Rango de presupuesto no válido.");
  if (descripcion.length < 20) throw badRequest("Cuéntanos un poco más (mínimo 20 caracteres).");
  if (body.acepta !== true) throw badRequest("Debes aceptar que te contactemos sobre esta solicitud.");

  return { nombre, email, telefono: telefono || null, empresa: empresa || null, tipo, presupuesto: presupuesto || null, descripcion };
}

// ── POST /solicitudes (público; con sesión usa los datos de la cuenta) ──
export const crearSolicitud = async (req, res) => {
  const body = req.body ?? {};

  // Anti-bots: campo trampa o envío instantáneo → "OK" falso, sin guardar nada.
  if (body.website || (Number(body.ms) || 0) < TIEMPO_MINIMO_MS) {
    console.warn(`🤖 Solicitud descartada como bot (ip ${req.ip})`);
    return res.status(201).json({ success: true, message: "Solicitud recibida.", data: { codigo: "S-0000" } });
  }

  let cuenta = null;
  if (req.usuario?.id) {
    const { rows } = await pool.query(
      "SELECT id, name, email, telefono, email_verificado FROM usuarios WHERE id = $1 AND NOT bloqueado",
      [req.usuario.id],
    );
    cuenta = rows[0] ?? null;
  }
  const d = validar(body, { conSesion: Boolean(cuenta) });
  const email = cuenta ? cuenta.email : d.email;
  const nombre = cuenta ? cuenta.name : d.nombre;

  // Con sesión, o si ese email ya pertenece a una cuenta verificada, queda vinculada al momento.
  let usuarioId = cuenta?.id ?? null;
  if (!usuarioId) {
    const { rows } = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1 AND email_verificado AND NOT bloqueado",
      [email],
    );
    usuarioId = rows[0]?.id ?? null;
  }

  const { rows: [s] } = await pool.query(
    `INSERT INTO solicitudes (usuario_id, email, nombre, telefono, empresa, tipo_proyecto, presupuesto,
                              descripcion, origen, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      usuarioId, email, nombre, d.telefono ?? cuenta?.telefono ?? null, d.empresa, d.tipo, d.presupuesto,
      d.descripcion, cuenta ? "area_cliente" : "web", req.ip || null,
      String(req.get("user-agent") || "").slice(0, 255) || null,
    ],
  );

  avisarSolicitudNueva(s).catch((e) => console.error("❌ Avisos de solicitud nueva:", e.message));

  // No se revela si el email tiene cuenta (evita enumerar cuentas desde un formulario público).
  res.status(201).json({
    success: true,
    message: "Solicitud recibida. Te escribiremos a tu correo.",
    data: { codigo: s.codigo, email },
  });
};

// ── GET /solicitudes/mias ───────────────────────────────────────
export const misSolicitudes = async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.codigo, s.tipo_proyecto, s.presupuesto, s.estado, s.created_at, s.updated_at,
            (SELECT max(m.created_at) FROM solicitud_mensajes m
              WHERE m.solicitud_id = s.id AND NOT m.interno) AS ultimo_mensaje,
            EXISTS (SELECT 1 FROM solicitud_mensajes m
                     WHERE m.solicitud_id = s.id AND NOT m.interno AND m.de_equipo) AS tiene_respuesta
       FROM solicitudes s
      WHERE s.usuario_id = $1
      ORDER BY s.created_at DESC
      LIMIT 100`,
    [req.usuario.id],
  );
  res.json({ success: true, data: rows });
};

async function miSolicitud(req) {
  const { rows } = await pool.query(
    "SELECT * FROM solicitudes WHERE codigo = $1 AND usuario_id = $2",
    [String(req.params.codigo || "").toUpperCase(), req.usuario.id],
  );
  if (!rows[0]) throw notFound("Solicitud no encontrada.");
  return rows[0];
}

const MENSAJES_PUBLICOS = `
  SELECT m.id, m.cuerpo, m.de_equipo, m.created_at,
         CASE WHEN m.de_equipo THEN split_part(u.name, ' ', 1) END AS autor
    FROM solicitud_mensajes m LEFT JOIN usuarios u ON u.id = m.autor_id
   WHERE m.solicitud_id = $1 AND NOT m.interno
   ORDER BY m.created_at`;

// ── GET /solicitudes/mias/:codigo ───────────────────────────────
export const verMiSolicitud = async (req, res) => {
  const s = await miSolicitud(req);
  const { rows: mensajes } = await pool.query(MENSAJES_PUBLICOS, [s.id]);
  res.json({
    success: true,
    data: {
      codigo: s.codigo, tipo_proyecto: s.tipo_proyecto, presupuesto: s.presupuesto, estado: s.estado,
      descripcion: s.descripcion, nombre: s.nombre, telefono: s.telefono, empresa: s.empresa,
      created_at: s.created_at, mensajes,
    },
  });
};

// ── POST /solicitudes/mias/:codigo/mensajes { cuerpo } ──────────
export const responderMiSolicitud = async (req, res) => {
  const s = await miSolicitud(req);
  const cuerpo = typeof req.body?.cuerpo === "string" ? req.body.cuerpo.trim().slice(0, 3000) : "";
  if (cuerpo.length < 2) throw badRequest("Escribe tu mensaje.");
  if (s.estado === "archivada") throw badRequest("Esta solicitud está archivada. Envía una nueva si lo necesitas.");

  const { rows: [m] } = await pool.query(
    `INSERT INTO solicitud_mensajes (solicitud_id, autor_id, de_equipo, cuerpo)
     VALUES ($1, $2, false, $3) RETURNING id, cuerpo, de_equipo, created_at`,
    [s.id, req.usuario.id, cuerpo],
  );
  // Si ya estaba respondida, vuelve a la bandeja del equipo.
  if (s.estado === "respondida") {
    await pool.query("UPDATE solicitudes SET estado = 'en_revision' WHERE id = $1", [s.id]);
  } else {
    await pool.query("UPDATE solicitudes SET updated_at = now() WHERE id = $1", [s.id]);
  }

  const { rows: [u] } = await pool.query("SELECT name FROM usuarios WHERE id = $1", [req.usuario.id]);
  avisarClienteRespondio(s, { cuerpo, nombre: u?.name ?? s.nombre }).catch((e) =>
    console.error("❌ Avisos de respuesta del cliente:", e.message),
  );
  res.status(201).json({ success: true, message: "Mensaje enviado.", data: { ...m, autor: null } });
};
