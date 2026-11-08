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
| POST | `/auth/otp/verificar` | `{ email, codigo }` → completa un login con `requiereOTP` |
| POST | `/auth/otp/reenviar` | `{ email }` → reenvía el OTP (solo si hay un login pendiente) |
| POST | `/auth/otp/activar` | Bearer → envía el código de activación |
| POST | `/auth/otp/activar/confirmar` | Bearer `{ codigo }` → activa el 2º factor |
| POST | `/auth/otp/desactivar` | Bearer `{ password }` → desactiva; en cuentas solo de Google devuelve `requiereCodigo` |
| POST | `/auth/otp/desactivar/confirmar` | Bearer `{ codigo }` → desactiva (cuentas solo de Google) |
| POST | `/auth/password/solicitar` | `{ email }` → código por email (respuesta genérica) |
| POST | `/auth/password/validar` | `{ email, codigo }` → `{ resetToken }` de un solo uso (10 min) |
| POST | `/auth/password/restablecer` | `{ resetToken, password }` → nueva contraseña; desbloquea la cuenta y cierra sus sesiones |
| PATCH | `/auth/password` | Bearer `{ actual, nueva }` → cambia la contraseña, cierra las demás sesiones y devuelve una nueva |
| GET | `/auth/google?next=/ruta` | navegación → redirige a Google |
| GET | `/auth/google/callback` | Google vuelve aquí → redirige al front (`/auth/google/callback`, `/login/otp` o `/login?error=`) |
| POST | `/solicitudes` | público (o Bearer) → solicitud de presupuesto; confirma por email y avisa al equipo |
| GET | `/solicitudes/mias` · `/solicitudes/mias/:codigo` | Bearer → mis solicitudes y su conversación |
| POST | `/solicitudes/mias/:codigo/mensajes` | Bearer `{ cuerpo }` → el cliente contesta |
| GET | `/admin/solicitudes` · `/admin/solicitudes/:id` | admin+ → listado con conteos y detalle |
| POST | `/admin/solicitudes/:id/mensajes` | admin+ `{ cuerpo, interno? }` → responder o dejar una nota interna |
| PATCH | `/admin/solicitudes/:id` | admin+ `{ estado?, asignado_a? }` |
| GET | `/notificaciones` · `/notificaciones/config` | Bearer → campana (no leídas) y canales en vivo disponibles |
| POST | `/notificaciones/leer` | Bearer `{ ids? }` → marcar leídas |
| POST | `/notificaciones/socket-token` | Bearer → JWT de socket-core (solo escucha, 10 min) |
| POST · DELETE | `/notificaciones/push` | Bearer → registrar o quitar la suscripción Web Push de este dispositivo |
| GET · PATCH | `/clientes/yo` | Bearer → mi ficha de cliente (`null` si no tengo) y edición de los datos de facturación |
| GET | `/clientes/yo/resumen` | Bearer → proyectos activos con el siguiente hito, conteos y actividad visible |
| GET | `/proyectos/mios` · `/proyectos/mios/:codigo` | Bearer → mis proyectos y su detalle (hitos) |
| GET · POST | `/admin/clientes` | admin+ → listado con conteos · alta manual (vincula la cuenta verificada con ese email) |
| GET · PATCH | `/admin/clientes/:id` | admin+ → ficha completa (proyectos, solicitudes, historial) · edición, incluidas notas internas y estado |
| GET · POST · PATCH | `/admin/servicios[/:id]` | admin+ → catálogo de servicios y precios (`?todos=1` incluye los inactivos) |
| POST · GET · PATCH | `/admin/proyectos[/:id]` | admin+ → crear, ver y editar proyectos e hitos (avisa al cliente de estado e hitos) |
| POST | `/admin/solicitudes/:id/convertir` | admin+ `{ cliente, proyecto }` → crea o completa la ficha, sube a cliente y crea el proyecto |
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

Cada push a `main` lanza `.github/workflows/deploy.yml`, que despliega en `/srv/infra/seventwo/seventwo-backend`:

1. Actualiza el código conservando el `.env`.
2. Crea la base `seventwo` en `postgres_central` si no existe.
3. Ejecuta `docker compose up -d --build`, que levanta la API en `127.0.0.1:4000` dentro de `central_network`. Las migraciones se aplican al arrancar el contenedor.
4. Saca o renueva el certificado con certbot e instala `nginx/seventwo-api.conf` para `api.seventwo.tech`.
5. Comprueba que `/health` responde.

Lo único manual es crear el `.env` en el VPS. La guía completa (DNS, secrets, variables y orden de deploy) está en `seventwo-frontend/docs/DEPLOY.md`.
