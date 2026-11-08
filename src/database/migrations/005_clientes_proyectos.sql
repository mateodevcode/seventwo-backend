-- 005_clientes_proyectos.sql — ficha de cliente, catálogo de servicios, proyectos,
-- hitos e historial de actividad (seventwo-frontend/docs/CLIENTES.md §4.1–4.2, F1).

-- Ficha de cliente: una cuenta = un cliente. usuario_id NULL mientras el cliente
-- no tenga cuenta; se vincula por email verificado (igual que las solicitudes).
CREATE TABLE IF NOT EXISTS clientes (
  id                 BIGSERIAL PRIMARY KEY,
  usuario_id         INTEGER UNIQUE REFERENCES usuarios(id) ON DELETE SET NULL,
  email              VARCHAR(255) NOT NULL UNIQUE CHECK (email = lower(email)),
  tipo_persona       VARCHAR(10)  NOT NULL DEFAULT 'natural' CHECK (tipo_persona IN ('natural', 'juridica')),
  nombre             VARCHAR(160) NOT NULL,            -- nombre completo o razón social
  nombre_comercial   VARCHAR(160),
  tipo_documento     VARCHAR(4)   CHECK (tipo_documento IN ('CC', 'CE', 'NIT', 'PAS')),
  numero_documento   VARCHAR(20),
  dv                 VARCHAR(1),
  email_facturacion  VARCHAR(255),
  telefono           VARCHAR(20),
  direccion          VARCHAR(200),
  ciudad             VARCHAR(80),
  departamento       VARCHAR(80),
  pais               VARCHAR(2)   NOT NULL DEFAULT 'CO',
  sitio_web          VARCHAR(200),
  sector             VARCHAR(80),
  contacto_nombre    VARCHAR(120),
  contacto_cargo     VARCHAR(80),
  contacto_telefono  VARCHAR(20),
  estado             VARCHAR(10)  NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'pausado', 'baja')),
  notas_internas     TEXT,
  alta_por           INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clientes_huerfanos_idx ON clientes (email) WHERE usuario_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clientes_documento_idx
  ON clientes (tipo_documento, numero_documento) WHERE numero_documento IS NOT NULL;

DROP TRIGGER IF EXISTS clientes_updated_at ON clientes;
CREATE TRIGGER clientes_updated_at BEFORE UPDATE ON clientes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Catálogo de servicios y precios (editable desde /admin).
CREATE TABLE IF NOT EXISTS servicios_catalogo (
  id            BIGSERIAL PRIMARY KEY,
  nombre        VARCHAR(120) NOT NULL,
  categoria     VARCHAR(12)  NOT NULL DEFAULT 'proyecto' CHECK (categoria IN ('proyecto', 'recurrente')),
  tipo_proyecto VARCHAR(40),
  descripcion   TEXT,
  incluye       TEXT[]       NOT NULL DEFAULT '{}',
  modelo_cobro  VARCHAR(12)  NOT NULL DEFAULT 'unico' CHECK (modelo_cobro IN ('unico', 'hitos', 'recurrente', 'horas')),
  precio_base   NUMERIC(14, 2),
  moneda        VARCHAR(3)   NOT NULL DEFAULT 'COP',
  periodicidad  VARCHAR(12)  CHECK (periodicidad IN ('mensual', 'trimestral', 'anual')),
  activo        BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS servicios_catalogo_updated_at ON servicios_catalogo;
CREATE TRIGGER servicios_catalogo_updated_at BEFORE UPDATE ON servicios_catalogo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE SEQUENCE IF NOT EXISTS proyectos_codigo_seq;

CREATE TABLE IF NOT EXISTS proyectos (
  id                      BIGSERIAL PRIMARY KEY,
  codigo                  VARCHAR(12) NOT NULL UNIQUE
                            DEFAULT ('P-' || lpad(nextval('proyectos_codigo_seq')::text, 4, '0')),
  cliente_id              BIGINT NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  solicitud_id            BIGINT UNIQUE REFERENCES solicitudes(id) ON DELETE SET NULL,
  servicio_id             BIGINT REFERENCES servicios_catalogo(id) ON DELETE SET NULL,
  nombre                  VARCHAR(160) NOT NULL,
  tipo_proyecto           VARCHAR(40),
  descripcion             TEXT,
  incluye                 TEXT[]       NOT NULL DEFAULT '{}',
  modelo_cobro            VARCHAR(12)  NOT NULL DEFAULT 'unico' CHECK (modelo_cobro IN ('unico', 'hitos', 'recurrente', 'horas')),
  valor_total             NUMERIC(14, 2),
  moneda                  VARCHAR(3)   NOT NULL DEFAULT 'COP',
  importe_periodo         NUMERIC(14, 2),
  periodicidad            VARCHAR(12)  CHECK (periodicidad IN ('mensual', 'trimestral', 'anual')),
  proximo_cobro           DATE,
  horas_contratadas       NUMERIC(8, 2),
  precio_hora             NUMERIC(14, 2),
  estado                  VARCHAR(14)  NOT NULL DEFAULT 'propuesta'
                            CHECK (estado IN ('propuesta', 'en_curso', 'pausado', 'entregado', 'mantenimiento', 'finalizado', 'cancelado')),
  fecha_inicio            DATE,
  fecha_entrega_estimada  DATE,
  fecha_entrega           DATE,
  fecha_fin               DATE,
  progreso                SMALLINT     NOT NULL DEFAULT 0 CHECK (progreso BETWEEN 0 AND 100),
  responsable_id          INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_por              INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proyectos_cliente_idx ON proyectos (cliente_id, created_at DESC);
DROP TRIGGER IF EXISTS proyectos_updated_at ON proyectos;
CREATE TRIGGER proyectos_updated_at BEFORE UPDATE ON proyectos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS proyecto_hitos (
  id                BIGSERIAL PRIMARY KEY,
  proyecto_id       BIGINT NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  orden             SMALLINT NOT NULL DEFAULT 0,
  nombre            VARCHAR(160) NOT NULL,
  descripcion       TEXT,
  fecha_prevista    DATE,
  fecha_completado  DATE,
  estado            VARCHAR(10) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'en_curso', 'completado')),
  porcentaje_cobro  NUMERIC(5, 2) CHECK (porcentaje_cobro BETWEEN 0 AND 100),
  importe           NUMERIC(14, 2),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proyecto_hitos_idx ON proyecto_hitos (proyecto_id, orden);

-- Historial: cada cambio relevante deja un evento. visible_cliente decide si
-- aparece en "Últimos movimientos" del área de cliente.
CREATE TABLE IF NOT EXISTS actividad (
  id               BIGSERIAL PRIMARY KEY,
  cliente_id       BIGINT REFERENCES clientes(id) ON DELETE CASCADE,
  actor_id         INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  entidad          VARCHAR(12) NOT NULL,
  entidad_id       BIGINT,
  accion           VARCHAR(40) NOT NULL,
  descripcion      VARCHAR(300) NOT NULL,
  datos            JSONB,
  visible_cliente  BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS actividad_cliente_idx ON actividad (cliente_id, created_at DESC);
