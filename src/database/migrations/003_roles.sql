-- 003_roles.sql — cuatro roles: usuario < cliente < admin < superadmin.
--   usuario     → rol por defecto al registrarse: perfil, seguridad y solicitar presupuesto
--   cliente     → servicio contratado (lo asciende un admin a mano)
--   admin       → equipo Seventwo: panel /admin, gestiona usuarios y clientes
--   superadmin  → además gestiona admins y bloqueos de cualquier cuenta
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('usuario', 'cliente', 'admin', 'superadmin'));
ALTER TABLE usuarios ALTER COLUMN rol SET DEFAULT 'usuario';

-- Cuentas creadas con el default anterior ('cliente') que nadie ascendió a mano:
-- pasan a 'usuario'. (En producción solo existe el superadmin; no afecta.)
UPDATE usuarios SET rol = 'usuario' WHERE rol = 'cliente';

CREATE INDEX IF NOT EXISTS usuarios_rol_idx ON usuarios (rol);
