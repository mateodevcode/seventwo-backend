// src/lib/almacen.js — archivos privados en S3 (contratos, comprobantes).
// - Las claves van bajo `<prefijo>/privado/…`, carpeta que la política del bucket
//   no hace pública. Nunca se devuelve un link permanente: solo URLs firmadas
//   de pocos minutos, generadas después de comprobar quién pide el archivo.
// - S3 verifica la integridad al subir (ChecksumSHA256) y la guarda: así se
//   puede comprobar más tarde que el contrato aceptado es exactamente el subido.
// - En NODE_ENV=test se usa un almacén en memoria (sin red).
import crypto from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AWS_BUCKET, AWS_PREFIJO, AWS_REGION, NODE_ENV, s3Configurado } from "../config.js";
import { HttpError } from "./errors.js";

const EN_PRUEBAS = NODE_ENV === "test";
export const memoriaPruebas = new Map(); // clave → { body, contentType, sha256 }

let cliente;
const s3 = () => (cliente ??= new S3Client({ region: AWS_REGION }));

export const almacenDisponible = () => EN_PRUEBAS || s3Configurado();

function exigir() {
  if (!almacenDisponible()) throw new HttpError(503, "El almacenamiento de archivos no está configurado.");
}

export const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const hexABase64 = (hex) => Buffer.from(hex, "hex").toString("base64");

/** Clave privada: <prefijo>/privado/<carpeta>/<AAAA>/<MM>/<uuid>.<ext> */
export function clavePrivada(carpeta, ext) {
  const d = new Date();
  const mes = String(d.getUTCMonth() + 1).padStart(2, "0");
  const limpia = String(carpeta).replace(/[^a-z0-9/_-]/gi, "");
  return `${AWS_PREFIJO}/privado/${limpia}/${d.getUTCFullYear()}/${mes}/${crypto.randomUUID()}.${ext}`;
}

/** Sube `body` (Buffer). Devuelve { clave, sha256, bytes }. */
export async function subir({ clave, body, contentType }) {
  exigir();
  const sha256 = sha256Hex(body);
  if (EN_PRUEBAS) {
    memoriaPruebas.set(clave, { body: Buffer.from(body), contentType, sha256 });
  } else {
    await s3().send(new PutObjectCommand({
      Bucket: AWS_BUCKET,
      Key: clave,
      Body: body,
      ContentType: contentType,
      ChecksumSHA256: hexABase64(sha256), // S3 rechaza la subida si no coincide
      ServerSideEncryption: "AES256",
      CacheControl: "private, no-store",
    }));
  }
  return { clave, sha256, bytes: body.length };
}

/** SHA-256 (hex) del objeto tal como está guardado ahora, o null si no existe. */
export async function sha256Guardado(clave) {
  exigir();
  if (EN_PRUEBAS) {
    const o = memoriaPruebas.get(clave);
    return o ? sha256Hex(o.body) : null;
  }
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: AWS_BUCKET, Key: clave, ChecksumMode: "ENABLED" }));
    return r.ChecksumSHA256 ? Buffer.from(r.ChecksumSHA256, "base64").toString("hex") : null;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/** URL firmada de lectura (por defecto 5 min) que abre el PDF en el navegador. */
export async function urlFirmada(clave, { nombre = "documento.pdf", contentType = "application/pdf", segundos = 300 } = {}) {
  exigir();
  const disposicion = `inline; filename="${nombre.replace(/[^\w.\- ]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(nombre)}`;
  if (EN_PRUEBAS) return `memoria://${clave}?expira=${segundos}`;
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: AWS_BUCKET, Key: clave, ResponseContentDisposition: disposicion, ResponseContentType: contentType }),
    { expiresIn: segundos },
  );
}

export async function borrar(clave) {
  exigir();
  if (EN_PRUEBAS) {
    memoriaPruebas.delete(clave);
    return;
  }
  await s3().send(new DeleteObjectCommand({ Bucket: AWS_BUCKET, Key: clave }));
}
