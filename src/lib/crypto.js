// src/lib/crypto.js — utilidades criptográficas para códigos y tokens.
import crypto from "node:crypto";
import { AUTH_PEPPER } from "../config.js";

export const sha256 = (valor) =>
  crypto.createHash("sha256").update(String(valor)).digest("hex");

// Hash de un código de un solo uso (OTP, reset, canje). Con pepper para que
// un volcado de la tabla no permita probar los 900k OTP posibles offline.
export const hashCodigo = (codigo) =>
  crypto.createHmac("sha256", AUTH_PEPPER).update(String(codigo).trim()).digest("hex");

// OTP numérico de 6 dígitos con CSPRNG.
export const generarOtp = () => String(crypto.randomInt(100_000, 1_000_000));

// Token opaco (reset_token, oauth_canje).
export const generarTokenOpaco = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");

// Compara dos hashes hex en tiempo constante.
export function hashesIguales(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
