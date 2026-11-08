// src/db.js — pool de conexiones a PostgreSQL.
import pg from "pg";
import { DB_CONFIG } from "./config.js";

export const pool = new pg.Pool({
  ...DB_CONFIG,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  console.error("❌ Error inesperado en el pool de Postgres:", err.message);
});

// Ejecuta `fn(client)` dentro de una transacción. Hace ROLLBACK si lanza.
export async function enTransaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resultado = await fn(client);
    await client.query("COMMIT");
    return resultado;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
