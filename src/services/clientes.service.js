// src/services/clientes.service.js — reglas de clientes, proyectos e historial
// (seventwo-frontend/docs/CLIENTES.md, F1).
import { pool } from "../db.js";
import { EQUIPO_EMAIL, FRONTEND_URL } from "../config.js";
import { badRequest } from "../lib/errors.js";
import * as v from "../lib/validar.js";
import * as plantillas from "../emails/clientes.js";
import { notificarEnSegundoPlano } from "./notificaciones.service.js";

export const TIPOS_DOCUMENTO = ["CC", "CE", "NIT", "PAS"];
export const ESTADOS_CLIENTE = ["activo", "pausado", "baja"];
export const MODELOS_COBRO = ["unico", "hitos", "recurrente", "horas"];
export const PERIODICIDADES = ["mensual", "trimestral", "anual"];
export const MONEDAS = ["COP", "USD"];
export const ESTADOS_PROYECTO = ["propuesta", "en_curso", "pausado", "entregado", "mantenimiento", "finalizado", "cancelado"];
export const ESTADOS_HITO = ["pendiente", "en_curso", "completado"];
// Estados en los que un proyecto cuenta como "activo" para el cliente.
export const PROYECTO_ACTIVO = ["propuesta", "en_curso", "pausado", "entregado", "mantenimiento"];

export const ETIQUETA_ESTADO_PROYECTO = {
  propuesta: "Propuesta",
  en_curso: "En curso",
  pausado: "Pausado",
  entregado: "Entregado",
  mantenimiento: "Mantenimiento",
  finalizado: "Finalizado",
  cancelado: "Cancelado",
};

export const rutaProyectoCliente = (codigo) => `/area-cliente?seccion=proyectos&proyecto=${encodeURIComponent(codigo)}`;
export const rutaClienteAdmin = (id) => `/admin?seccion=clientes&cliente=${id}`;
const abs = (ruta) => `${FRONTEND_URL}${ruta}`;

// ── Ficha de cliente ─────────────────────────────────────────────

const documento = (x) => {
  const s = v.texto(x, { max: 24, nombre: "El documento" });
  if (!s) return null;
  const limpio = s.replace(/[.\s-]/g, "").toUpperCase();
  if (!/^[0-9A-Z]{3,20}$/.test(limpio)) throw "Número de documento no válido.";
  return limpio;
};

/** Campos que el propio cliente puede editar. */
const REGLAS_CLIENTE = {
  tipo_persona: (x) => v.opcion(x, ["natural", "juridica"], { nombre: "El tipo de persona" }) ?? "natural",
  nombre: (x) => v.texto(x, { max: 160, min: 2, requerido: true, nombre: "El nombre o razón social" }),
  nombre_comercial: (x) => v.texto(x, { max: 160, nombre: "El nombre comercial" }),
  tipo_documento: (x) => v.opcion(x, TIPOS_DOCUMENTO, { nombre: "El tipo de documento" }),
  numero_documento: documento,
  dv: (x) => {
    const s = v.texto(x, { max: 1, nombre: "El DV" });
    if (s && !/^\d$/.test(s)) throw "El DV es un dígito.";
    return s;
  },
  email_facturacion: (x) => v.email(x),
  telefono: (x) => v.telefono(x),
  direccion: (x) => v.texto(x, { max: 200, nombre: "La dirección" }),
  ciudad: (x) => v.texto(x, { max: 80, nombre: "La ciudad" }),
  departamento: (x) => v.texto(x, { max: 80, nombre: "El departamento" }),
  pais: (x) => {
    const s = v.texto(x, { max: 2, nombre: "El país" });
    if (s && !/^[A-Za-z]{2}$/.test(s)) throw "País no válido (código de 2 letras).";
    return (s ?? "CO").toUpperCase();
  },
  sitio_web: (x) => v.url(x),
  sector: (x) => v.texto(x, { max: 80, nombre: "El sector" }),
  contacto_nombre: (x) => v.texto(x, { max: 120, nombre: "El nombre de contacto" }),
  contacto_cargo: (x) => v.texto(x, { max: 80, nombre: "El cargo" }),
  contacto_telefono: (x) => v.telefono(x),
};

/** Además, solo el equipo. */
const REGLAS_EQUIPO = {
  estado: (x) => v.opcion(x, ESTADOS_CLIENTE, { nombre: "El estado" }) ?? "activo",
  notas_internas: (x) => v.parrafo(x, { max: 5000, nombre: "Las notas" }),
};

export const CAMPOS_CLIENTE = Object.keys(REGLAS_CLIENTE);

/**
 * Valida la ficha. `equipo` permite estado y notas internas.
 * @returns {object} solo los campos presentes (si parcial) ya normalizados
 */
export function validarFicha(body, { equipo = false, parcial = false } = {}) {
  const reglas = equipo ? { ...REGLAS_CLIENTE, ...REGLAS_EQUIPO } : REGLAS_CLIENTE;
  const { datos, errores } = v.aplicar(body, reglas, { parcial });
  const final = { ...datos };
  // El DV solo tiene sentido con NIT.
  if (final.dv && final.tipo_documento && final.tipo_documento !== "NIT") final.dv = null;
  if (Object.keys(errores).length) throw badRequest("Revisa los datos marcados.", { errores });
  return final;
}

/** Vista pública de la ficha (lo que ve el propio cliente). */
export function fichaPublica(c) {
  if (!c) return null;
  const { notas_internas, alta_por, usuario_id, ...resto } = c;
  return resto;
}

/** Diferencias entre la ficha anterior y los cambios (para el historial). */
export function diferencias(antes, cambios) {
  const d = {};
  for (const [k, nuevo] of Object.entries(cambios)) {
    const viejo = antes[k] ?? null;
    // pg devuelve BIGINT como texto: los escalares se comparan como texto.
    const igual = Array.isArray(viejo) || Array.isArray(nuevo)
      ? JSON.stringify(viejo ?? []) === JSON.stringify(nuevo ?? [])
      : String(viejo ?? "") === String(nuevo ?? "");
    if (!igual) d[k] = { antes: viejo, despues: nuevo ?? null };
  }
  return d;
}

export const ETIQUETA_CAMPO = {
  tipo_persona: "tipo de persona", nombre: "nombre", nombre_comercial: "nombre comercial",
  tipo_documento: "tipo de documento", numero_documento: "documento", dv: "DV",
  email_facturacion: "email de facturación", telefono: "teléfono", direccion: "dirección",
  ciudad: "ciudad", departamento: "departamento", pais: "país", sitio_web: "web", sector: "sector",
  contacto_nombre: "contacto", contacto_cargo: "cargo", contacto_telefono: "teléfono de contacto",
  estado: "estado", notas_internas: "notas internas",
};

/** UPDATE de los campos de `cambios`. Devuelve la fila nueva. */
export async function actualizarCliente(db, id, cambios) {
  const claves = Object.keys(cambios);
  if (!claves.length) {
    const { rows } = await db.query("SELECT * FROM clientes WHERE id = $1", [id]);
    return rows[0];
  }
  const { rows } = await db.query(
    `UPDATE clientes SET ${claves.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
    [id, ...claves.map((k) => cambios[k])],
  );
  return rows[0];
}

/** Ficha del cliente de una cuenta, o null. */
export async function clienteDeUsuario(usuarioId) {
  const { rows } = await pool.query("SELECT * FROM clientes WHERE usuario_id = $1", [usuarioId]);
  return rows[0] ?? null;
}

/**
 * Vinculación por email verificado (igual que las solicitudes): una ficha creada
 * sin cuenta se asigna a la cuenta con ese email y la cuenta pasa a "cliente".
 * @returns {Promise<string|null>} el rol nuevo si cambió
 */
export async function vincularClientePorEmail(usuario) {
  if (!usuario.email_verificado) return null;
  const { rows } = await pool.query(
    "UPDATE clientes SET usuario_id = $1 WHERE email = $2 AND usuario_id IS NULL RETURNING id",
    [usuario.id, usuario.email],
  );
  if (!rows[0]) return null;
  await registrarActividad(pool, {
    cliente_id: rows[0].id, actor_id: usuario.id, entidad: "cliente", entidad_id: rows[0].id,
    accion: "cuenta_vinculada", descripcion: "Creaste tu cuenta y quedó vinculada a tu ficha de cliente",
    visible_cliente: true,
  });
  return ascenderACliente(pool, usuario.id);
}

/** usuario → cliente (nunca baja un rol mayor). Devuelve el rol nuevo o null. */
export async function ascenderACliente(db, usuarioId) {
  const { rows } = await db.query(
    "UPDATE usuarios SET rol = 'cliente' WHERE id = $1 AND rol = 'usuario' RETURNING rol",
    [usuarioId],
  );
  return rows[0]?.rol ?? null;
}

// ── Historial ────────────────────────────────────────────────────

export async function registrarActividad(db, { cliente_id, actor_id = null, entidad, entidad_id = null, accion, descripcion, datos = null, visible_cliente = false }) {
  await db.query(
    `INSERT INTO actividad (cliente_id, actor_id, entidad, entidad_id, accion, descripcion, datos, visible_cliente)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [cliente_id, actor_id, entidad, entidad_id, accion, descripcion.slice(0, 300), datos, visible_cliente],
  );
}

export async function actividadDe(clienteId, { soloCliente = false, limite = 30 } = {}) {
  const { rows } = await pool.query(
    `SELECT a.id, a.entidad, a.entidad_id, a.accion, a.descripcion, a.visible_cliente, a.created_at,
            ${soloCliente ? "" : "a.datos, u.name AS actor,"} a.actor_id IS NOT NULL AND u.rol IN ('admin','superadmin') AS de_equipo
       FROM actividad a LEFT JOIN usuarios u ON u.id = a.actor_id
      WHERE a.cliente_id = $1 ${soloCliente ? "AND a.visible_cliente" : ""}
      ORDER BY a.created_at DESC, a.id DESC LIMIT $2`,
    [clienteId, limite],
  );
  return rows;
}

// ── Proyectos ────────────────────────────────────────────────────

const REGLAS_PROYECTO = {
  nombre: (x) => v.texto(x, { max: 160, min: 2, requerido: true, nombre: "El nombre del proyecto" }),
  tipo_proyecto: (x) => v.texto(x, { max: 40, nombre: "El tipo de proyecto" }),
  descripcion: (x) => v.parrafo(x, { max: 5000, nombre: "La descripción" }),
  incluye: (x) => v.lista(x, { nombre: "Lo que incluye" }),
  modelo_cobro: (x) => v.opcion(x, MODELOS_COBRO, { nombre: "El modelo de cobro" }) ?? "unico",
  valor_total: (x) => v.dinero(x, { nombre: "El valor total" }),
  moneda: (x) => v.opcion(x, MONEDAS, { nombre: "La moneda" }) ?? "COP",
  importe_periodo: (x) => v.dinero(x, { nombre: "El importe por periodo" }),
  periodicidad: (x) => v.opcion(x, PERIODICIDADES, { nombre: "La periodicidad" }),
  proximo_cobro: (x) => v.fecha(x),
  horas_contratadas: (x) => v.decimal(x, { max: 100000, nombre: "Las horas" }),
  precio_hora: (x) => v.dinero(x, { nombre: "El precio por hora" }),
  estado: (x) => v.opcion(x, ESTADOS_PROYECTO, { nombre: "El estado" }) ?? "propuesta",
  fecha_inicio: (x) => v.fecha(x),
  fecha_entrega_estimada: (x) => v.fecha(x),
  fecha_entrega: (x) => v.fecha(x),
  fecha_fin: (x) => v.fecha(x),
  progreso: (x) => v.entero(x, { min: 0, max: 100, nombre: "El progreso" }) ?? 0,
  responsable_id: (x) => v.entero(x, { min: 1, max: 2 ** 31 - 1, nombre: "El responsable" }),
  servicio_id: (x) => v.entero(x, { min: 1, max: Number.MAX_SAFE_INTEGER, nombre: "El servicio" }),
};

const REGLAS_HITO = {
  id: (x) => v.entero(x, { min: 1, max: Number.MAX_SAFE_INTEGER, nombre: "El hito" }),
  nombre: (x) => v.texto(x, { max: 160, min: 2, requerido: true, nombre: "El nombre del hito" }),
  descripcion: (x) => v.parrafo(x, { max: 2000, nombre: "La descripción del hito" }),
  fecha_prevista: (x) => v.fecha(x),
  estado: (x) => v.opcion(x, ESTADOS_HITO, { nombre: "El estado del hito" }) ?? "pendiente",
  porcentaje_cobro: (x) => v.decimal(x, { min: 0, max: 100, nombre: "El porcentaje" }),
  importe: (x) => v.dinero(x, { nombre: "El importe del hito" }),
};

/** Valida un proyecto (y sus hitos si vienen). Comprueba responsable y servicio en BD. */
export async function validarProyecto(body, { parcial = false } = {}) {
  const { datos, errores } = v.aplicar(body, REGLAS_PROYECTO, { parcial });

  let hitos;
  if (body && "hitos" in body) {
    if (!Array.isArray(body.hitos) || body.hitos.length > 30) errores.hitos = "Máximo 30 hitos.";
    else {
      hitos = [];
      body.hitos.forEach((h, i) => {
        const r = v.aplicar(h, REGLAS_HITO);
        for (const [k, msg] of Object.entries(r.errores)) errores[`hitos.${i}.${k}`] = msg;
        hitos.push(r.datos);
      });
      const pct = hitos.reduce((s, h) => s + (h.porcentaje_cobro ?? 0), 0);
      if (pct > 100.001) errores.hitos = "Los porcentajes de cobro de los hitos suman más del 100 %.";
    }
  }

  if (datos.responsable_id) {
    const { rows } = await pool.query(
      "SELECT 1 FROM usuarios WHERE id = $1 AND rol IN ('admin', 'superadmin') AND NOT bloqueado",
      [datos.responsable_id],
    );
    if (!rows[0]) errores.responsable_id = "El responsable debe ser alguien del equipo.";
  }
  if (datos.servicio_id) {
    const { rows } = await pool.query("SELECT 1 FROM servicios_catalogo WHERE id = $1", [datos.servicio_id]);
    if (!rows[0]) errores.servicio_id = "Ese servicio no existe.";
  }
  if (datos.fecha_inicio && datos.fecha_entrega_estimada && datos.fecha_entrega_estimada < datos.fecha_inicio) {
    errores.fecha_entrega_estimada = "La entrega no puede ser anterior al inicio.";
  }
  if (Object.keys(errores).length) throw badRequest("Revisa los datos del proyecto.", { errores });
  return { datos, hitos };
}

/**
 * Sustituye los hitos del proyecto: los que traen id se actualizan, los nuevos
 * se insertan y los que faltan se borran. Devuelve los hitos que pasaron a
 * "completado" en esta operación (para avisar al cliente).
 */
export async function guardarHitos(db, proyectoId, hitos) {
  const { rows: actuales } = await db.query("SELECT * FROM proyecto_hitos WHERE proyecto_id = $1", [proyectoId]);
  const porId = new Map(actuales.map((h) => [String(h.id), h]));
  const completados = [];
  const conservar = [];

  for (const [orden, h] of hitos.entries()) {
    const previo = h.id ? porId.get(String(h.id)) : null;
    if (h.id && !previo) throw badRequest("Uno de los hitos no pertenece a este proyecto.");
    const pasaACompletado = h.estado === "completado" && previo?.estado !== "completado";
    const valores = [h.nombre, h.descripcion, h.fecha_prevista, h.estado, h.porcentaje_cobro, h.importe, orden];
    if (previo) {
      await db.query(
        `UPDATE proyecto_hitos
            SET nombre = $2, descripcion = $3, fecha_prevista = $4, estado = $5, porcentaje_cobro = $6,
                importe = $7, orden = $8,
                fecha_completado = CASE WHEN $5::varchar = 'completado' THEN COALESCE(fecha_completado, CURRENT_DATE) ELSE NULL END
          WHERE id = $1`,
        [previo.id, ...valores],
      );
      conservar.push(previo.id);
    } else {
      const { rows } = await db.query(
        `INSERT INTO proyecto_hitos (proyecto_id, nombre, descripcion, fecha_prevista, estado, porcentaje_cobro, importe, orden, fecha_completado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $5::varchar = 'completado' THEN CURRENT_DATE END) RETURNING id`,
        [proyectoId, ...valores],
      );
      conservar.push(rows[0].id);
    }
    if (pasaACompletado) completados.push(h.nombre);
  }
  await db.query("DELETE FROM proyecto_hitos WHERE proyecto_id = $1 AND NOT (id = ANY($2::bigint[]))", [proyectoId, conservar]);
  return completados;
}

/** Proyecto con hitos, responsable y solicitud de origen. */
export async function detalleProyecto(db, id, { paraCliente = false } = {}) {
  const { rows: [p] } = await db.query(
    `SELECT p.*, r.name AS responsable, s.codigo AS solicitud_codigo, sc.nombre AS servicio
       FROM proyectos p
       LEFT JOIN usuarios r ON r.id = p.responsable_id
       LEFT JOIN solicitudes s ON s.id = p.solicitud_id
       LEFT JOIN servicios_catalogo sc ON sc.id = p.servicio_id
      WHERE p.id = $1`,
    [id],
  );
  if (!p) return null;
  const { rows: hitos } = await db.query(
    `SELECT id, orden, nombre, descripcion, fecha_prevista, fecha_completado, estado, porcentaje_cobro, importe
       FROM proyecto_hitos WHERE proyecto_id = $1 ORDER BY orden, id`,
    [id],
  );
  const proyecto = { ...p, hitos };
  if (paraCliente) {
    delete proyecto.creado_por;
    delete proyecto.responsable_id;
    delete proyecto.solicitud_id;
    delete proyecto.servicio_id;
  }
  return proyecto;
}

/** Inserta el proyecto (y sus hitos) dentro de `db`. */
export async function crearProyecto(db, { cliente_id, solicitud_id = null, creado_por, datos, hitos = [] }) {
  const campos = Object.keys(datos);
  const { rows: [p] } = await db.query(
    `INSERT INTO proyectos (cliente_id, solicitud_id, creado_por${campos.map((c) => `, ${c}`).join("")})
     VALUES ($1, $2, $3${campos.map((_, i) => `, $${i + 4}`).join("")}) RETURNING *`,
    [cliente_id, solicitud_id, creado_por, ...campos.map((c) => datos[c])],
  );
  if (hitos.length) await guardarHitos(db, p.id, hitos);
  return p;
}

// ── Avisos al cliente ────────────────────────────────────────────

async function cuentaDeCliente(cliente) {
  if (!cliente.usuario_id) return null;
  const { rows } = await pool.query(
    "SELECT id, socket_id, name FROM usuarios WHERE id = $1 AND NOT bloqueado",
    [cliente.usuario_id],
  );
  return rows[0] ?? null;
}

const urlRegistro = (email, ruta) =>
  abs(`/registro?email=${encodeURIComponent(email)}&next=${encodeURIComponent(ruta)}`);

export async function avisarProyectoCreado(proyecto, cliente) {
  const cuenta = await cuentaDeCliente(cliente);
  const ruta = rutaProyectoCliente(proyecto.codigo);
  const cta = cuenta
    ? { urlCta: abs(ruta), textoCta: "Ver mi proyecto" }
    : { urlCta: urlRegistro(cliente.email, ruta), textoCta: "Crea tu cuenta para seguirlo" };
  notificarEnSegundoPlano({
    usuarios: cuenta ? [cuenta] : [],
    tipo: "proyecto_creado",
    titulo: `Tu proyecto ${proyecto.codigo} ya está en Seventwo`,
    cuerpo: proyecto.nombre,
    url: ruta,
    datos: { codigo: proyecto.codigo },
    email: {
      to: cliente.email,
      replyTo: EQUIPO_EMAIL,
      ...plantillas.proyectoCreado({
        name: cuenta?.name ?? cliente.contacto_nombre ?? cliente.nombre,
        codigo: proyecto.codigo,
        nombre: proyecto.nombre,
        ...cta,
      }),
    },
  });
}

/** Cambio de estado o hitos completados: solo in-app (BD, socket, push). */
export async function avisarProyectoActualizado(proyecto, cliente, { estado, hitosCompletados = [] }) {
  const cuenta = await cuentaDeCliente(cliente);
  if (!cuenta) return;
  const ruta = rutaProyectoCliente(proyecto.codigo);
  if (estado) {
    notificarEnSegundoPlano({
      usuarios: [cuenta],
      tipo: "proyecto_estado",
      titulo: `${proyecto.codigo}: ${ETIQUETA_ESTADO_PROYECTO[estado]}`,
      cuerpo: proyecto.nombre,
      url: ruta,
      datos: { codigo: proyecto.codigo, estado },
    });
  }
  for (const nombre of hitosCompletados) {
    notificarEnSegundoPlano({
      usuarios: [cuenta],
      tipo: "proyecto_hito",
      titulo: `Hito completado en ${proyecto.codigo}`,
      cuerpo: nombre,
      url: ruta,
      datos: { codigo: proyecto.codigo },
    });
  }
}
