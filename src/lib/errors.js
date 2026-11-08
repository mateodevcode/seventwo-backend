// src/lib/errors.js — error HTTP controlado. Lanzarlo desde un controlador
// hace que el errorHandler responda { success: false, error } con su status.
export class HttpError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export const badRequest = (msg, data) => new HttpError(400, msg, data);
export const unauthorized = (msg = "No autenticado.") => new HttpError(401, msg);
export const forbidden = (msg = "No tienes permisos para esta acción.") => new HttpError(403, msg);
export const notFound = (msg = "Recurso no encontrado.") => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);
export const tooMany = (msg = "Demasiadas solicitudes. Intenta más tarde.") => new HttpError(429, msg);
