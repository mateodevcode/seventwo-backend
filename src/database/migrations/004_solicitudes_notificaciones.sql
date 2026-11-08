-- 004_solicitudes_notificaciones.sql — solicitudes de presupuesto, conversación,
-- bandeja de notificaciones y suscripciones Web Push (docs/PRESUPUESTOS.md §4).

-- Identificador opaco para socket-core (no exponer ids ni emails en `sub`).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS socket_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_socket_id_idx ON usuarios (socket_id);

CREATE SEQUENCE IF NOT EXISTS solicitudes_codigo_seq;

CREATE TABLE IF NOT EXISTS solicitudes (
  id            BIGSERIAL PRIMARY KEY,
  codigo        VARCHAR(12) NOT NULL UNIQUE
                  DEFAULT ('S-' || lpad(nextval('solicitudes_codigo_seq')::text, 4, '0')),
  usuario_id    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  email         VARCHAR(255) NOT NULL CHECK (email = lower(email)),
  nombre        VARCHAR(100) NOT NULL,
  telefono      VARCHAR(20),
  empresa       VARCHAR(120),
  tipo_proyecto VARCHAR(40)  NOT NULL,
  presupuesto   VARCHAR(40),
  descripcion   TEXT NOT NULL,
  estado        VARCHAR(20)  NOT NULL DEFAULT 'nueva'
                  CHECK (estado IN ('nueva', 'en_revision', 'respondida', 'aceptada', 'rechazada', 'archivada')),
  origen        VARCHAR(20)  NOT NULL DEFAULT 'web' CHECK (origen IN ('web', 'area_cliente')),
  asignado_a    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  ip            INET,
  user_agent    VARCHAR(255),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS solicitudes_huerfanas_idx ON solicitudes (email) WHERE usuario_id IS NULL;
CREATE INDEX IF NOT EXISTS solicitudes_usuario_idx ON solicitudes (usuario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS solicitudes_estado_idx ON solicitudes (estado, created_at DESC);

DROP TRIGGER IF EXISTS solicitudes_updated_at ON solicitudes;
CREATE TRIGGER solicitudes_updated_at
  BEFORE UPDATE ON solicitudes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS solicitud_mensajes (
  id            BIGSERIAL PRIMARY KEY,
  solicitud_id  BIGINT  NOT NULL REFERENCES solicitudes(id) ON DELETE CASCADE,
  autor_id      INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,  -- NULL = el solicitante (mensaje inicial)
  de_equipo     BOOLEAN NOT NULL DEFAULT false,
  cuerpo        TEXT    NOT NULL,
  interno       BOOLEAN NOT NULL DEFAULT false,                      -- nota solo para el equipo
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS solicitud_mensajes_idx ON solicitud_mensajes (solicitud_id, created_at);

CREATE TABLE IF NOT EXISTS notificaciones (
  id          BIGSERIAL PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo        VARCHAR(40)  NOT NULL,
  titulo      VARCHAR(160) NOT NULL,
  cuerpo      VARCHAR(500),
  url         VARCHAR(300),
  datos       JSONB,
  leida_en    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notificaciones_usuario_idx ON notificaciones (usuario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notificaciones_no_leidas_idx ON notificaciones (usuario_id) WHERE leida_en IS NULL;

CREATE TABLE IF NOT EXISTS push_suscripciones (
  id          BIGSERIAL PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      VARCHAR(200) NOT NULL,
  auth        VARCHAR(100) NOT NULL,
  user_agent  VARCHAR(255),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_uso  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS push_suscripciones_usuario_idx ON push_suscripciones (usuario_id);
