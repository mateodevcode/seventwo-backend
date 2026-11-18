-- 008_tickets.sql — tickets de soporte del cliente (seventwo-frontend/docs/CLIENTES.md §4.5, F5).

CREATE SEQUENCE IF NOT EXISTS tickets_codigo_seq;

CREATE TABLE IF NOT EXISTS tickets (
  id                BIGSERIAL PRIMARY KEY,
  codigo            VARCHAR(12) NOT NULL UNIQUE
                      DEFAULT ('T-' || lpad(nextval('tickets_codigo_seq')::text, 4, '0')),
  cliente_id        BIGINT NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  proyecto_id       BIGINT REFERENCES proyectos(id) ON DELETE SET NULL,
  creado_por        INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  asunto            VARCHAR(160) NOT NULL,
  categoria         VARCHAR(12) NOT NULL DEFAULT 'consulta'
                      CHECK (categoria IN ('incidencia', 'cambio', 'consulta', 'pagos')),
  prioridad         VARCHAR(8) NOT NULL DEFAULT 'normal'
                      CHECK (prioridad IN ('baja', 'normal', 'alta', 'urgente')),
  estado            VARCHAR(18) NOT NULL DEFAULT 'abierto'
                      CHECK (estado IN ('abierto', 'en_progreso', 'esperando_cliente', 'resuelto', 'cerrado')),
  asignado_a        INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  ultimo_mensaje_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrado_en        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tickets_cliente_idx ON tickets (cliente_id, ultimo_mensaje_en DESC);
CREATE INDEX IF NOT EXISTS tickets_estado_idx ON tickets (estado, ultimo_mensaje_en DESC);
DROP TRIGGER IF EXISTS tickets_updated_at ON tickets;
CREATE TRIGGER tickets_updated_at BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ticket_mensajes (
  id          BIGSERIAL PRIMARY KEY,
  ticket_id   BIGINT  NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  autor_id    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  de_equipo   BOOLEAN NOT NULL DEFAULT false,
  cuerpo      TEXT    NOT NULL,
  interno     BOOLEAN NOT NULL DEFAULT false,   -- nota solo para el equipo
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_mensajes_idx ON ticket_mensajes (ticket_id, created_at);
