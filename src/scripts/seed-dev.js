// src/scripts/seed-dev.js — cuentas de prueba, una por rol, SOLO en desarrollo.
//   npm run seed:dev
// Todas con la contraseña de abajo, email verificado. Idempotente (upsert por email).
// Se niega a correr en producción o contra una BD que no sea local.
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { DB_CONFIG, IS_PROD } from "../config.js";

export const PASSWORD_DEV = "prueba1234";

const CUENTAS = [
  { name: "Sofía Superadmin", email: "superadmin@seventwo.test", rol: "superadmin" },
  { name: "Andrés Admin", email: "admin@seventwo.test", rol: "admin" },
  { name: "Carla Cliente", email: "cliente@seventwo.test", rol: "cliente" },
  { name: "Ulises Usuario", email: "usuario@seventwo.test", rol: "usuario" },
  { name: "Úrsula Usuaria", email: "usuaria@seventwo.test", rol: "usuario" },
];

const host = DB_CONFIG?.host ?? new URL(DB_CONFIG?.connectionString ?? "postgres://x").hostname;
if (IS_PROD || !["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`❌ seed-dev solo corre en desarrollo contra una BD local (host actual: ${host}).`);
  process.exit(1);
}

try {
  const hash = await bcrypt.hash(PASSWORD_DEV, 10);
  for (const c of CUENTAS) {
    await pool.query(
      `INSERT INTO usuarios (name, email, password, rol, provider, email_verificado)
       VALUES ($1, $2, $3, $4, 'local', true)
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name, password = EXCLUDED.password, rol = EXCLUDED.rol,
             email_verificado = true, bloqueado = false, intentos_fallidos = 0, otp_activo = false`,
      [c.name, c.email, hash, c.rol],
    );
    console.log(`✔ ${c.rol.padEnd(10)} ${c.email}`);
  }
  console.log(`\nContraseña de todas: ${PASSWORD_DEV}`);
} finally {
  await pool.end();
}
