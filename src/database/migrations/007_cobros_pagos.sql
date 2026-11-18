-- 007_cobros_pagos.sql — cobros (lo que el cliente debe pagar), pagos y
-- comprobantes (seventwo-frontend/docs/CLIENTES.md §4.5, F3).
-- Sin documento fiscal por ahora: Seventwo (S.A.S. con IVA) factura por su
-- proveedor DIAN; aquí se lleva la trazabilidad de qué se cobra y qué se pagó.

-- Recordatorio previo al cobro (días antes del vencimiento), por proyecto.
ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS recordatorio_dias SMALLINT NOT NULL DEFAULT 3
  CHECK (recordatorio_dias BETWEEN 0 AND 30);

CREATE SEQUENCE IF NOT EXISTS cobros_codigo_seq;

CREATE TABLE IF NOT EXISTS cobros (
  id                      BIGSERIAL PRIMARY KEY,
  codigo                  VARCHAR(12) NOT NULL UNIQUE
                            DEFAULT ('C-' || lpad(nextval('cobros_codigo_seq')::text, 4, '0')),
  cliente_id              BIGINT NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  proyecto_id             BIGINT NOT NULL REFERENCES proyectos(id) ON DELETE RESTRICT,
  hito_id                 BIGINT REFERENCES proyecto_hitos(id) ON DELETE SET NULL,
  tipo                    VARCHAR(12) NOT NULL DEFAULT 'manual' CHECK (tipo IN ('recurrente', 'hito', 'manual')),
  concepto                VARCHAR(200) NOT NULL,
  periodo_inicio          DATE,                       -- recurrentes: periodo que cubre
  periodo_fin             DATE,
  importe                 NUMERIC(14, 2) NOT NULL CHECK (importe > 0),
  moneda                  VARCHAR(3) NOT NULL DEFAULT 'COP',
  fecha_vencimiento       DATE NOT NULL,              -- día en que se debe pagar
  estado                  VARCHAR(10) NOT NULL DEFAULT 'pendiente'
                            CHECK (estado IN ('pendiente', 'parcial', 'pagado', 'anulado')),
  pagado_en               DATE,
  recordatorio_enviado_en TIMESTAMPTZ,
  vencido_avisado_en      TIMESTAMPTZ,
  anulado_motivo          VARCHAR(300),
  creado_por              INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cobros_cliente_idx ON cobros (cliente_id, fecha_vencimiento DESC);
CREATE INDEX IF NOT EXISTS cobros_proyecto_idx ON cobros (proyecto_id, fecha_vencimiento DESC);
CREATE INDEX IF NOT EXISTS cobros_abiertos_idx ON cobros (fecha_vencimiento) WHERE estado IN ('pendiente', 'parcial');
-- Un solo cobro recurrente por proyecto y fecha (la generación automática es idempotente).
CREATE UNIQUE INDEX IF NOT EXISTS cobros_recurrente_unico
  ON cobros (proyecto_id, fecha_vencimiento) WHERE tipo = 'recurrente';

DROP TRIGGER IF EXISTS cobros_updated_at ON cobros;
CREATE TRIGGER cobros_updated_at BEFORE UPDATE ON cobros FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS pagos (
  id                     BIGSERIAL PRIMARY KEY,
  cobro_id               BIGINT NOT NULL REFERENCES cobros(id) ON DELETE RESTRICT,
  cliente_id             BIGINT NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  importe                NUMERIC(14, 2) NOT NULL CHECK (importe > 0),
  moneda                 VARCHAR(3) NOT NULL DEFAULT 'COP',
  fecha_pago             DATE NOT NULL,
  via                    VARCHAR(14) NOT NULL
                           CHECK (via IN ('mercadopago', 'nequi', 'transferencia', 'efectivo', 'tarjeta', 'otro')),
  estado                 VARCHAR(16) NOT NULL DEFAULT 'confirmado'
                           CHECK (estado IN ('en_verificacion', 'confirmado', 'rechazado')),
  referencia             VARCHAR(120),
  notas                  VARCHAR(500),
  comprobante_archivo_id UUID REFERENCES archivos(id) ON DELETE SET NULL,
  lectura_ia             JSONB,                  -- F4: datos leídos del comprobante
  mp_payment_id          VARCHAR(40) UNIQUE,     -- F4: Mercado Pago
  registrado_por         INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  confirmado_por         INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  confirmado_en          TIMESTAMPTZ,
  rechazo_motivo         VARCHAR(300),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pagos_cobro_idx ON pagos (cobro_id);
CREATE INDEX IF NOT EXISTS pagos_cliente_idx ON pagos (cliente_id, fecha_pago DESC);
CREATE INDEX IF NOT EXISTS pagos_verificar_idx ON pagos (created_at) WHERE estado = 'en_verificacion';
