// src/lib/validar.js — normalizadores de campos para los formularios de la API.
// Cada uno recibe el valor crudo del body y devuelve el valor limpio, null
// (vacío) o lanza un string con el mensaje de error del campo.
export const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const RE_TELEFONO = /^\+?[\d\s().-]{7,20}$/;

const vacio = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

export function texto(v, { max = 200, min = 0, requerido = false, nombre = "Este campo" } = {}) {
  if (vacio(v)) {
    if (requerido) throw `${nombre} es obligatorio.`;
    return null;
  }
  if (typeof v !== "string" && typeof v !== "number") throw `${nombre} no es válido.`;
  const s = String(v).trim().replace(/\s+/g, " ");
  if (s.length < min) throw `${nombre} es demasiado corto.`;
  if (s.length > max) throw `${nombre} admite como máximo ${max} caracteres.`;
  return s;
}

/** Texto largo: conserva los saltos de línea. */
export function parrafo(v, { max = 5000, nombre = "Este campo" } = {}) {
  if (vacio(v)) return null;
  if (typeof v !== "string") throw `${nombre} no es válido.`;
  const s = v.trim();
  if (s.length > max) throw `${nombre} admite como máximo ${max} caracteres.`;
  return s;
}

export function email(v, { requerido = false } = {}) {
  if (vacio(v)) {
    if (requerido) throw "El email es obligatorio.";
    return null;
  }
  const s = String(v).trim().toLowerCase();
  if (s.length > 255 || !RE_EMAIL.test(s)) throw "Email no válido.";
  return s;
}

export function telefono(v) {
  if (vacio(v)) return null;
  const s = String(v).trim();
  if (!RE_TELEFONO.test(s)) throw "Teléfono no válido.";
  return s;
}

export function opcion(v, opciones, { requerido = false, nombre = "Valor" } = {}) {
  if (vacio(v)) {
    if (requerido) throw `${nombre} es obligatorio.`;
    return null;
  }
  if (!opciones.includes(v)) throw `${nombre} no es válido.`;
  return v;
}

/** Fecha YYYY-MM-DD (se guarda como DATE). */
export function fecha(v) {
  if (vacio(v)) return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw "Fecha no válida.";
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw "Fecha no válida.";
  return s;
}

/** Importe ≥ 0 con hasta 2 decimales. Acepta número o texto ("4800000", "4.800.000" no). */
export function dinero(v, { nombre = "El importe" } = {}) {
  if (vacio(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw `${nombre} no es válido.`;
  return Math.round(n * 100) / 100;
}

export function entero(v, { min = 0, max = 100, nombre = "El valor" } = {}) {
  if (vacio(v)) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw `${nombre} no es válido.`;
  return n;
}

export function decimal(v, { min = 0, max = 100, nombre = "El valor" } = {}) {
  if (vacio(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw `${nombre} no es válido.`;
  return Math.round(n * 100) / 100;
}

export function url(v) {
  if (vacio(v)) return null;
  let s = String(v).trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw 0;
    if (s.length > 200) throw 0;
    return u.toString().replace(/\/$/, "");
  } catch {
    throw "Dirección web no válida.";
  }
}

/** Lista de textos cortos (p. ej. "lo que incluye"). */
export function lista(v, { maxItems = 30, max = 200, nombre = "La lista" } = {}) {
  if (vacio(v)) return [];
  if (!Array.isArray(v)) throw `${nombre} no es válida.`;
  const items = v.map((x) => (typeof x === "string" ? x.trim().replace(/\s+/g, " ") : "")).filter(Boolean);
  if (items.length > maxItems) throw `${nombre} admite como máximo ${maxItems} elementos.`;
  if (items.some((x) => x.length > max)) throw `Cada elemento admite como máximo ${max} caracteres.`;
  return items;
}

/**
 * Aplica `reglas` ({campo: (valor) => limpio}) a `body`. Solo procesa los campos
 * presentes si `parcial`; si no, todos. Devuelve { datos, errores }.
 */
export function aplicar(body, reglas, { parcial = false } = {}) {
  const datos = {};
  const errores = {};
  for (const [campo, regla] of Object.entries(reglas)) {
    if (parcial && !(campo in (body ?? {}))) continue;
    try {
      datos[campo] = regla(body?.[campo]);
    } catch (e) {
      errores[campo] = typeof e === "string" ? e : "No válido.";
    }
  }
  return { datos, errores };
}
