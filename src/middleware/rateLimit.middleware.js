// src/middleware/rateLimit.middleware.js — rate limit con contador en Postgres
// (sin Redis). Una sola consulta atómica por request.
//
//   router.post("/auth/login", rateLimit({ nombre: "login", max: 10, ventanaSeg: 600 }), login)
//
// `clave(req)` permite limitar por algo distinto de la IP (p. ej. el email).
// Si Postgres falla se deja pasar (fail-open): el límite no debe tumbar la API.
import { pool } from "../db.js";

const SQL = `
  INSERT INTO rate_limits (clave, contador, expira_en)
  VALUES ($1, 1, now() + make_interval(secs => $2))
  ON CONFLICT (clave) DO UPDATE SET
    contador  = CASE WHEN rate_limits.expira_en < now() THEN 1
                     ELSE rate_limits.contador + 1 END,
    expira_en = CASE WHEN rate_limits.expira_en < now() THEN now() + make_interval(secs => $2)
                     ELSE rate_limits.expira_en END
  RETURNING contador, EXTRACT(EPOCH FROM (expira_en - now()))::int AS restante`;

export async function consumir(clave, max, ventanaSeg) {
  const { rows } = await pool.query(SQL, [clave.slice(0, 200), ventanaSeg]);
  const { contador, restante } = rows[0];
  return { limitado: contador > max, reintentarEn: Math.max(restante, 1) };
}

export const rateLimit = ({ nombre, max, ventanaSeg, clave = (req) => req.ip }) =>
  async (req, res, next) => {
    const valor = clave(req);
    if (!valor) return next();
    try {
      const { limitado, reintentarEn } = await consumir(`${nombre}:${valor}`, max, ventanaSeg);
      if (limitado) {
        res.set("Retry-After", String(reintentarEn));
        return res.status(429).json({
          success: false,
          error: "Demasiadas solicitudes. Intenta más tarde.",
          data: { reintentarEn },
        });
      }
    } catch (error) {
      console.warn(`⚠️  Rate limit '${nombre}' sin BD, se deja pasar:`, error.message);
    }
    next();
  };

// Clave por email del body (normalizado), para frenar ataques a una cuenta
// concreta desde muchas IPs.
export const porEmail = (req) => {
  const email = req.body?.email;
  return typeof email === "string" ? `email:${email.trim().toLowerCase()}` : null;
};
