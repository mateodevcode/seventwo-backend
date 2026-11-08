// src/services/codigos.service.js — códigos de un solo uso (tabla auth_codigos).
// Reglas en docs/AUTH.md §4: el código se guarda hasheado, emitir uno nuevo
// invalida los anteriores del mismo tipo y agotar intentos invalida el código
// (nunca bloquea la cuenta).
import { pool } from "../db.js";
import { generarOtp, generarTokenOpaco, hashCodigo, hashesIguales } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";

export const REGLAS = {
  verificar_email: { validezSeg: 15 * 60, maxIntentos: 5, cooldownSeg: 60 },
  otp_login:       { validezSeg: 10 * 60, maxIntentos: 5, cooldownSeg: 60 },
  otp_activar:     { validezSeg: 10 * 60, maxIntentos: 5, cooldownSeg: 60 },
  otp_desactivar:  { validezSeg: 10 * 60, maxIntentos: 5, cooldownSeg: 60 },
  reset_password:  { validezSeg: 10 * 60, maxIntentos: 5, cooldownSeg: 60 },
  reset_token:     { validezSeg: 10 * 60, maxIntentos: 1, cooldownSeg: 0 },
  oauth_canje:     { validezSeg: 2 * 60,  maxIntentos: 1, cooldownSeg: 0 },
};

const reglas = (tipo) => {
  const r = REGLAS[tipo];
  if (!r) throw new Error(`Tipo de código desconocido: ${tipo}`);
  return r;
};

// Segundos que faltan para poder pedir otro código (0 = ya se puede).
export async function cooldownRestante(usuarioId, tipo, db = pool) {
  const { cooldownSeg } = reglas(tipo);
  if (!cooldownSeg) return 0;
  const { rows } = await db.query(
    `SELECT GREATEST(0, $3 - EXTRACT(EPOCH FROM (now() - created_at)))::int AS restante
       FROM auth_codigos
      WHERE usuario_id = $1 AND tipo = $2
      ORDER BY created_at DESC LIMIT 1`,
    [usuarioId, tipo, cooldownSeg],
  );
  return rows[0]?.restante ?? 0;
}

/**
 * Emite un código nuevo e invalida los anteriores del mismo tipo.
 * Lanza 429 si se pide antes del cooldown, salvo `ignorarCooldown`.
 * @returns {Promise<string>} el código en claro (para enviarlo por email)
 */
export async function emitirCodigo({ usuarioId, tipo, payload = null, ignorarCooldown = false }, db = pool) {
  const { validezSeg } = reglas(tipo);

  if (!ignorarCooldown) {
    const restante = await cooldownRestante(usuarioId, tipo, db);
    if (restante > 0) {
      throw new HttpError(429, `Espera ${restante} segundos antes de pedir otro código.`, { reintentarEn: restante });
    }
  }

  const esOpaco = tipo === "reset_token" || tipo === "oauth_canje";
  const codigo = esOpaco ? generarTokenOpaco() : generarOtp();

  if (usuarioId != null) {
    await db.query(
      `UPDATE auth_codigos SET usado_en = now()
        WHERE usuario_id = $1 AND tipo = $2 AND usado_en IS NULL`,
      [usuarioId, tipo],
    );
  }
  await db.query(
    `INSERT INTO auth_codigos (usuario_id, tipo, codigo_hash, payload, expira_en)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [usuarioId, tipo, hashCodigo(codigo), payload, validezSeg],
  );
  return codigo;
}

// Invalida los códigos activos de un tipo (p. ej. si falló el envío del email).
export async function invalidarCodigos(usuarioId, tipo, db = pool) {
  await db.query(
    "UPDATE auth_codigos SET usado_en = now() WHERE usuario_id = $1 AND tipo = $2 AND usado_en IS NULL",
    [usuarioId, tipo],
  );
}

/**
 * Verifica un OTP de 6 dígitos del usuario. Si es correcto lo consume.
 * Si es incorrecto suma un intento y, al llegar al máximo, lo invalida.
 * @returns {Promise<null | { payload: any }>} null si no es válido
 */
export async function verificarCodigo({ usuarioId, tipo, codigo }, db = pool) {
  const { maxIntentos } = reglas(tipo);
  if (!/^\d{6}$/.test(String(codigo ?? "").trim())) return null;

  const { rows } = await db.query(
    `SELECT id, codigo_hash, intentos, payload
       FROM auth_codigos
      WHERE usuario_id = $1 AND tipo = $2 AND usado_en IS NULL AND expira_en > now()
      ORDER BY created_at DESC LIMIT 1
      FOR UPDATE`,
    [usuarioId, tipo],
  );
  const fila = rows[0];
  if (!fila) return null;

  if (!hashesIguales(fila.codigo_hash, hashCodigo(codigo))) {
    await db.query(
      `UPDATE auth_codigos
          SET intentos = intentos + 1,
              usado_en = CASE WHEN intentos + 1 >= $2 THEN now() ELSE NULL END
        WHERE id = $1`,
      [fila.id, maxIntentos],
    );
    return null;
  }

  // Consumo atómico: si otra petición lo usó en paralelo, no vale dos veces.
  const { rowCount } = await db.query(
    "UPDATE auth_codigos SET usado_en = now() WHERE id = $1 AND usado_en IS NULL",
    [fila.id],
  );
  return rowCount ? { payload: fila.payload } : null;
}

/**
 * Consume un token opaco (reset_token, oauth_canje) buscándolo por su hash.
 * @returns {Promise<null | { usuarioId: number, payload: any }>}
 */
export async function consumirToken({ tipo, token }, db = pool) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await db.query(
    `UPDATE auth_codigos SET usado_en = now()
      WHERE codigo_hash = $1 AND tipo = $2 AND usado_en IS NULL AND expira_en > now()
      RETURNING usuario_id, payload`,
    [hashCodigo(token), tipo],
  );
  return rows[0] ? { usuarioId: rows[0].usuario_id, payload: rows[0].payload } : null;
}
