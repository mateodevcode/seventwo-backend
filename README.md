# seventwo-backend

API de Seventwo (auth y área de cliente). Stack: Express 5, PostgreSQL y Nodemailer con el SMTP de Brevo.
La especificación de la autenticación está en `seventwo-frontend/docs/AUTH.md`.

## Desarrollo local

```bash
cp .env.example .env      # rellena los secretos (el comando para generarlos está en el archivo)
npm install
npm run db:up             # Postgres 18 en Docker, en localhost:5442
npm run migrate
npm run dev               # http://localhost:4000/health
```

Si no configuras el SMTP, los emails (OTP, reset…) se imprimen en la consola.

## Estructura

```
src/
  index.js              arranque, validación de config, cierre ordenado
  app.js                Express: helmet, CORS con credenciales, rutas, errores
  config.js             variables de entorno y validación
  db.js                 pool de pg y enTransaccion()
  database/
    migrate.js          aplica migrations/*.sql pendientes (tabla schema_migrations)
    migrations/         SQL versionado
  middleware/           auth (JWT), rateLimit (en Postgres), errores
  lib/                  crypto (OTP, hashes), mailer, HttpError
  emails/               plantillas HTML
  jobs/                 limpieza horaria de códigos y tokens caducados
```

## Producción (VPS)

`docker compose up -d --build` levanta la API en `127.0.0.1:4000` dentro de la red de Postgres
(`DB_NETWORK`, por defecto `central_network`). Las migraciones se aplican al arrancar el contenedor.
nginx hace de proxy para `api.seventwo.tech` con TLS.
