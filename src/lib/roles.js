// src/lib/roles.js — jerarquía de roles y reglas de gestión.
//   usuario < cliente < admin < superadmin
export const ROLES = ["usuario", "cliente", "admin", "superadmin"];
export const ROLES_ADMIN = ["admin", "superadmin"];
export const ROLES_CLIENTE = ["cliente", "admin", "superadmin"];

export const nivel = (rol) => ROLES.indexOf(rol);
export const esRolValido = (rol) => ROLES.includes(rol);

/**
 * ¿Puede `actor` gestionar (cambiar rol / bloquear) a `objetivo`?
 * - Nadie se gestiona a sí mismo.
 * - Un superadmin no se gestiona desde la API (solo con el script del VPS).
 * - admin: solo a usuarios y clientes.
 * - superadmin: a usuarios, clientes y admins.
 */
export function puedeGestionar(actor, objetivo) {
  if (!actor || !objetivo) return false;
  if (actor.id === objetivo.id) return false;
  if (objetivo.rol === "superadmin") return false;
  if (actor.rol === "superadmin") return true;
  if (actor.rol === "admin") return objetivo.rol === "usuario" || objetivo.rol === "cliente";
  return false;
}

/** Roles que `actor` puede asignar desde la API (nunca superadmin). */
export function rolesAsignables(actor) {
  if (actor?.rol === "superadmin") return ["usuario", "cliente", "admin"];
  if (actor?.rol === "admin") return ["usuario", "cliente"];
  return [];
}
