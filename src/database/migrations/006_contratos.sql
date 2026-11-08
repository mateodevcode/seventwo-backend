-- 006_contratos.sql — archivos privados en S3 y contratos con aceptación en la app
-- (seventwo-frontend/docs/CLIENTES.md §4.3–4.4, F2).

-- Un archivo = un objeto privado en S3. En la BD solo su clave (nunca un link
-- público) y su huella SHA-256, que sirve de evidencia de qué se aceptó.
CREATE TABLE IF NOT EXISTS archivos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id       BIGINT REFERENCES clientes(id) ON DELETE SET NULL,
  subido_por       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  nombre_original  VARCHAR(200) NOT NULL,
  mime             VARCHAR(80)  NOT NULL,
  bytes            INTEGER      NOT NULL CHECK (bytes > 0),
  sha256           CHAR(64)     NOT NULL,
  s3_clave         VARCHAR(400) NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS archivos_cliente_idx ON archivos (cliente_id);

-- Versiones del contrato de un proyecto. Solo una versión "vigente" a la vez
-- (enviado, aceptado o firmado_fuera); al enviar otra, la anterior pasa a "reemplazado".
CREATE TABLE IF NOT EXISTS contratos (
  id               BIGSERIAL PRIMARY KEY,
  proyecto_id      BIGINT  NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL,
  titulo           VARCHAR(160) NOT NULL,
  nota             VARCHAR(1000),                 -- mensaje al cliente al enviarlo
  archivo_id       UUID    NOT NULL REFERENCES archivos(id) ON DELETE RESTRICT,
  sha256           CHAR(64) NOT NULL,             -- copia de la huella al crearlo
  estado           VARCHAR(14) NOT NULL DEFAULT 'borrador'
                     CHECK (estado IN ('borrador', 'enviado', 'aceptado', 'firmado_fuera', 'reemplazado')),
  creado_por       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  enviado_en       TIMESTAMPTZ,
  enviado_por      INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  aceptado_en      TIMESTAMPTZ,
  aceptado_por     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  aceptado_nombre  VARCHAR(160),                  -- nombre que escribió al aceptar
  aceptado_ip      INET,
  aceptado_ua      VARCHAR(255),
  reemplazado_en   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proyecto_id, version)
);
CREATE INDEX IF NOT EXISTS contratos_proyecto_idx ON contratos (proyecto_id, version DESC);
CREATE UNIQUE INDEX IF NOT EXISTS contratos_vigente_idx
  ON contratos (proyecto_id) WHERE estado IN ('enviado', 'aceptado', 'firmado_fuera');
