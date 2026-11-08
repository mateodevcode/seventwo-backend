// src/app.js — construcción de la app Express (sin escuchar puerto, para tests).
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import { FRONTEND_URLS, IS_PROD } from "./config.js";
import { pool } from "./db.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";

export function crearApp() {
  const app = express();

  // Un solo salto (nginx) para que req.ip sea la IP real del cliente.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || FRONTEND_URLS.includes(origin)),
      credentials: true, // cookie refresh_token
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "100kb" }));
  if (!IS_PROD) app.use(morgan("dev"));

  app.get("/health", async (req, res) => {
    let db = "ok";
    try {
      await pool.query("SELECT 1");
    } catch {
      db = "error";
    }
    res.status(db === "ok" ? 200 : 503).json({ status: db === "ok" ? "ok" : "degraded", service: "seventwo-backend", db });
  });

  // Rutas (fase 2+): app.use(authRoutes) ...

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
