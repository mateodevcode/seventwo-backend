// src/scripts/rol.js — asigna un rol a mano (único camino para crear superadmins).
//
// En el VPS:
//   docker exec seventwo-backend node src/scripts/rol.js <email>              → muestra el rol
//   docker exec seventwo-backend node src/scripts/rol.js <email> superadmin   → lo asigna
// En local:
//   node --env-file=.env src/scripts/rol.js <email> admin
import { pool } from "../db.js";
import { ROLES } from "../lib/roles.js";
import { revocarTodas } from "../services/sesion.service.js";

const [emailArg, rol] = process.argv.slice(2);
const email = String(emailArg || "").trim().toLowerCase();

try {
  if (!email) {
    console.log(`Uso: node src/scripts/rol.js <email> [${ROLES.join("|")}]`);
    process.exitCode = 1;
  } else if (rol && !ROLES.includes(rol)) {
    console.error(`❌ Rol no válido: ${rol}. Opciones: ${ROLES.join(", ")}`);
    process.exitCode = 1;
  } else {
    const { rows: [u] } = await pool.query("SELECT id, name, email, rol FROM usuarios WHERE email = $1", [email]);
    if (!u) {
      console.error(`❌ No existe ningún usuario con ${email}`);
      process.exitCode = 1;
    } else if (!rol || rol === u.rol) {
      console.log(`${u.name} <${u.email}> · rol: ${u.rol}`);
    } else {
      await pool.query("UPDATE usuarios SET rol = $2 WHERE id = $1", [u.id, rol]);
      // Bajar de admin/superadmin corta su acceso ya (su token llevaba el rol anterior).
      if (["admin", "superadmin"].includes(u.rol)) await revocarTodas(u.id);
      console.log(`✅ ${u.name} <${u.email}> · ${u.rol} → ${rol}`);
    }
  }
} finally {
  await pool.end();
}
