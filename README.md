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

## Tests

```bash
npm run test:db           # una sola vez: crea la BD seventwo_test en el contenedor
npm test                  # node:test, de punta a punta contra seventwo_test
```

Los tests vacían las tablas: se niegan a correr contra una BD cuyo nombre no termine en `_test`.

## Endpoints disponibles

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/registro` | `{ name, email, password, telefono? }` → crea la cuenta y envía el código de verificación |
| POST | `/auth/verificar-email` | `{ email, codigo }` → verifica el correo y emite la sesión |
| POST | `/auth/verificar-email/reenviar` | `{ email }` → reenvía el código (cooldown de 60 s) |
| POST | `/auth/login` | `{ email, password }` → sesión, `requiereVerificacion` o `requiereOTP` |
| POST | `/auth/refresh` | cookie → `{ usuario, accessToken }` y rota la cookie |
| POST | `/auth/logout` | cookie → revoca la sesión actual |
| POST | `/auth/logout-todo` | Bearer → revoca todas las sesiones |
| GET | `/auth/me` | Bearer → usuario actual |

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
