// src/database/migrate.js — aplica en orden los .sql de ./migrations que aún
// no estén registrados en schema_migrations. Cada archivo corre en su propia
// transacción. Uso:  npm run migrate
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "../db.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrar({ log = console.log } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      nombre     VARCHAR(255) PRIMARY KEY,
      aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query("SELECT nombre FROM schema_migrations");
  const aplicadas = new Set(rows.map((r) => r.nombre));

  const archivos = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let nuevas = 0;

  for (const archivo of archivos) {
    if (aplicadas.has(archivo)) continue;
    const sql = await readFile(path.join(dir, archivo), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (nombre) VALUES ($1)", [archivo]);
      await client.query("COMMIT");
      log(`✅ Migración aplicada: ${archivo}`);
      nuevas++;
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Falló la migración ${archivo}: ${error.message}`);
    } finally {
      client.release();
    }
  }

  if (!nuevas) log("✔ Base de datos al día, no hay migraciones pendientes.");
  return nuevas;
}

// Ejecutado directamente (npm run migrate)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrar()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error(`❌ ${error.message}`);
      await pool.end();
      process.exit(1);
    });
}
