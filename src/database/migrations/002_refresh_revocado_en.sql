-- 002_refresh_revocado_en.sql — cuándo y por qué se revocó un refresh token.
-- Permite una ventana de gracia ante refresh concurrentes (dos pestañas) sin
-- confundirlo con la reutilización de un token robado. La gracia solo aplica
-- a motivo = 'rotacion'; un logout o una revocación masiva son definitivos.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revocado_en TIMESTAMPTZ;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revocado_motivo VARCHAR(20)
  CHECK (revocado_motivo IN ('rotacion', 'logout', 'revocacion'));
