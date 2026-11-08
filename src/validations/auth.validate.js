// src/validations/auth.validate.js
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normalizarEmail = (email) =>
  typeof email === "string" ? email.trim().toLowerCase() : "";

export const emailValido = (email) => email.length <= 255 && EMAIL_RE.test(email);

// bcrypt ignora lo que pase de 72 bytes: se limita para que no haya
// contraseñas "largas" que en realidad se truncan.
export function validarPassword(password) {
  if (typeof password !== "string") return "La contraseña es obligatoria.";
  if (password.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (Buffer.byteLength(password, "utf8") > 72) return "La contraseña es demasiado larga (máx. 72 caracteres).";
  if (!/[A-Za-zÀ-ÿ]/.test(password) || !/\d/.test(password)) {
    return "La contraseña debe incluir al menos una letra y un número.";
  }
  return null;
}

export function validarRegistro({ name, email, password }) {
  const errores = [];
  const nombre = typeof name === "string" ? name.trim() : "";
  if (nombre.length < 2 || nombre.length > 100) errores.push("El nombre debe tener entre 2 y 100 caracteres.");
  if (!emailValido(email)) errores.push("El email no es válido.");
  const errPass = validarPassword(password);
  if (errPass) errores.push(errPass);
  return errores;
}
