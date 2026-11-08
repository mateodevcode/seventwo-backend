// src/middleware/error.middleware.js
// Express 5 propaga solo los rechazos de promesas, así que los controladores
// async pueden lanzar HttpError sin try/catch.
import { HttpError } from "../lib/errors.js";

export const notFoundHandler = (req, res) => {
  res.status(404).json({ success: false, error: "Ruta no encontrada." });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      success: false,
      error: err.message,
      ...(err.data !== undefined && { data: err.data }),
    });
  }

  // JSON mal formado en el body
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, error: "JSON inválido." });
  }

  console.error(`❌ ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ success: false, error: "Error interno del servidor." });
};
