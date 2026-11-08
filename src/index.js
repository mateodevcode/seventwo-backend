// src/index.js — punto de entrada.
process.env.TZ = "UTC";

import { PORT, validarConfig } from "./config.js";

try {
  validarConfig();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

const { crearApp } = await import("./app.js");
const { pool } = await import("./db.js");
const { iniciarLimpieza } = await import("./jobs/limpieza.job.js");
const { verificarSmtp } = await import("./lib/mailer.js");

const app = crearApp();
const server = app.listen(PORT, () => {
  console.log(`🚀 seventwo-backend escuchando en http://localhost:${PORT}`);
});

iniciarLimpieza();
verificarSmtp();

const apagar = (senal) => {
  console.log(`\n${senal} recibido, cerrando...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => apagar("SIGTERM"));
process.on("SIGINT", () => apagar("SIGINT"));
