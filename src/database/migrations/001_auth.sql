-- 001_auth.sql — tablas de autenticación (ver seventwo-frontend/docs/AUTH.md §3)

CREATE TABLE IF NOT EXISTS usuarios (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  email             VARCHAR(255) NOT NULL UNIQUE CHECK (email = lower(email)),
  password          VARCHAR(255),                         -- NULL en cuentas solo-Google
  telefono          VARCHAR(20),
  rol               VARCHAR(30)  NOT NULL DEFAULT 'cliente'
                      CHECK (rol IN ('cliente', 'admin', 'superadmin')),
  provider          VARCHAR(20)  NOT NULL DEFAULT 'local'
                      CHECK (provider IN ('local', 'google')),
  google_id         VARCHAR(255) UNIQUE,
  image_url         VARCHAR(500),
  email_verificado  BOOLEAN      NOT NULL DEFAULT false,
  otp_activo        BOOLEAN      NOT NULL DEFAULT false,
  bloqueado         BOOLEAN      NOT NULL DEFAULT false,
  intentos_fallidos INTEGER      NOT NULL DEFAULT 0,
  ultimo_login      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS usuarios_updated_at ON usuarios;
CREATE TRIGGER usuarios_updated_at
  BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          SERIAL PRIMARY KEY,
  usuario_id  INTEGER     NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash  CHAR(64)    NOT NULL UNIQUE,                -- sha256 del JWT
  expira_en   TIMESTAMPTZ NOT NULL,
  revocado    BOOLEAN     NOT NULL DEFAULT false,
  user_agent  VARCHAR(255),
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_usuario_idx
  ON refresh_tokens (usuario_id) WHERE revocado = false;

CREATE TABLE IF NOT EXISTS auth_codigos (
  id          BIGSERIAL PRIMARY KEY,
  usuario_id  INTEGER     REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo        VARCHAR(30) NOT NULL CHECK (tipo IN (
                'verificar_email', 'otp_login', 'otp_activar', 'otp_desactivar',
                'reset_password', 'reset_token', 'oauth_canje')),
  codigo_hash CHAR(64)    NOT NULL,                       -- sha256(codigo + AUTH_PEPPER)
  payload     JSONB,
  intentos    INTEGER     NOT NULL DEFAULT 0,
  expira_en   TIMESTAMPTZ NOT NULL,
  usado_en    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_codigos_activos_idx
  ON auth_codigos (usuario_id, tipo) WHERE usado_en IS NULL;
CREATE INDEX IF NOT EXISTS auth_codigos_hash_idx
  ON auth_codigos (codigo_hash) WHERE usado_en IS NULL;

CREATE TABLE IF NOT EXISTS rate_limits (
  clave      VARCHAR(200) PRIMARY KEY,
  contador   INTEGER      NOT NULL,
  expira_en  TIMESTAMPTZ  NOT NULL
);
