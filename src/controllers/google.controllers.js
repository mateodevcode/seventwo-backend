// src/controllers/google.controllers.js — ingreso con Google (OAuth 2.0
// Authorization Code, todo en el servidor; docs/AUTH.md §5.4).
//
//   GET /auth/google?next=/area-cliente  → redirige a Google
//   GET /auth/google/callback?code&state → crea/vincula la cuenta y:
//       · con OTP activo → FRONTEND/login/otp?email=…&next=…
//       · sin OTP        → pone la cookie refresh y va a FRONTEND/auth/google/callback?next=…
//         (el front llama a POST /auth/refresh para obtener el accessToken)
//       · error          → FRONTEND/login?error=<codigo>
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import {
  FRONTEND_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  IS_PROD,
  JWT_SECRET,
  googleConfigurado,
} from "../config.js";
import * as plantillas from "../emails/index.js";
import { enviarCodigo } from "../services/envio.service.js";
import { emitirSesion, revocarTodas } from "../services/sesion.service.js";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

// Cookie que ata el `state` al navegador que inició el flujo: evita que un
// atacante haga que la víctima termine logueada en la cuenta del atacante.
const COOKIE_STATE = "g_state";
const opcionesCookieState = () => ({
  httpOnly: true,
  secure: IS_PROD,
  sameSite: "lax", // debe viajar en la redirección top-level desde Google
  path: "/auth/google",
  maxAge: 10 * 60 * 1000,
});

// Solo rutas internas: "/algo", nunca "//dominio" ni URLs absolutas.
export const sanearNext = (next) =>
  typeof next === "string" && /^\/(?![/\\])/.test(next) && next.length <= 300 ? next : "/area-cliente";

const alFront = (res, ruta, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  res.redirect(302, `${FRONTEND_URL}${ruta}${qs ? `?${qs}` : ""}`);
};
const errorAlLogin = (res, codigo) => alFront(res, "/login", { error: codigo });

class ErrorGoogle extends Error {
  constructor(codigo, detalle) {
    super(detalle || codigo);
    this.codigo = codigo;
  }
}

// ── GET /auth/google ────────────────────────────────────────────
export const iniciarGoogle = (req, res) => {
  if (!googleConfigurado()) return errorAlLogin(res, "google_no_configurado");

  const nonce = crypto.randomBytes(16).toString("hex");
  const state = jwt.sign(
    { prop: "google_state", next: sanearNext(req.query.next), nonce },
    JWT_SECRET,
    { expiresIn: "10m" },
  );
  res.cookie(COOKIE_STATE, nonce, opcionesCookieState());

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state,
  });
  res.redirect(302, `${GOOGLE_AUTH_URL}?${params}`);
};

async function obtenerPerfil(code) {
  const tr = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const tokens = await tr.json().catch(() => ({}));
  if (!tr.ok || !tokens.access_token) {
    throw new ErrorGoogle("google_codigo_invalido", `token: ${String(tokens.error || tr.status).slice(0, 40)}`);
  }

  const ur = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const perfil = await ur.json().catch(() => ({}));
  if (!ur.ok || !perfil.sub || !perfil.email) throw new ErrorGoogle("google_perfil_invalido");
  if (perfil.email_verified !== true) throw new ErrorGoogle("google_email_no_verificado");
  return perfil;
}

// Busca por google_id, luego por email; crea o vincula.
async function crearOVincular(perfil) {
  const email = String(perfil.email).toLowerCase();
  const nombre = String(perfil.name || email.split("@")[0]).slice(0, 255);
  const foto = typeof perfil.picture === "string" ? perfil.picture.slice(0, 500) : null;

  const porGoogle = (await pool.query("SELECT * FROM usuarios WHERE google_id = $1", [perfil.sub])).rows[0];
  if (porGoogle) return porGoogle;

  const porEmail = (await pool.query("SELECT * FROM usuarios WHERE email = $1", [email])).rows[0];
  if (!porEmail) {
    const { rows: [nuevo] } = await pool.query(
      `INSERT INTO usuarios (name, email, password, provider, google_id, image_url, email_verificado)
       VALUES ($1, $2, NULL, 'google', $3, $4, true) RETURNING *`,
      [nombre, email, perfil.sub, foto],
    );
    return nuevo;
  }

  if (porEmail.google_id && porEmail.google_id !== perfil.sub) {
    throw new ErrorGoogle("google_cuenta_distinta");
  }

  // Cuenta local con el email SIN verificar: alguien pudo registrarla antes
  // con el email de la víctima. Google prueba que el dueño real es quien
  // entra, así que se descarta esa contraseña y sus sesiones.
  const descartarPassword = !porEmail.email_verificado && porEmail.password;
  if (descartarPassword) await revocarTodas(porEmail.id);

  const { rows: [vinculado] } = await pool.query(
    `UPDATE usuarios
        SET google_id = $2,
            image_url = COALESCE(image_url, $3),
            email_verificado = true,
            password = CASE WHEN $4 THEN NULL ELSE password END,
            provider = CASE WHEN $4 THEN 'google' ELSE provider END
      WHERE id = $1 RETURNING *`,
    [porEmail.id, perfil.sub, foto, Boolean(descartarPassword)],
  );
  return vinculado;
}

// ── GET /auth/google/callback ───────────────────────────────────
export const callbackGoogle = async (req, res) => {
  const nonceCookie = req.cookies?.[COOKIE_STATE];
  const { maxAge, ...optsBorrar } = opcionesCookieState();
  res.clearCookie(COOKIE_STATE, optsBorrar);

  try {
    if (!googleConfigurado()) throw new ErrorGoogle("google_no_configurado");
    if (req.query.error) throw new ErrorGoogle(req.query.error === "access_denied" ? "google_cancelado" : "google_error");

    let state;
    try {
      state = jwt.verify(String(req.query.state || ""), JWT_SECRET);
    } catch {
      throw new ErrorGoogle("google_estado_invalido");
    }
    if (state.prop !== "google_state" || !nonceCookie || state.nonce !== nonceCookie) {
      throw new ErrorGoogle("google_estado_invalido");
    }
    if (!req.query.code) throw new ErrorGoogle("google_sin_codigo");

    const perfil = await obtenerPerfil(String(req.query.code));
    const usuario = await crearOVincular(perfil);
    const next = sanearNext(state.next);

    if (usuario.bloqueado) throw new ErrorGoogle("cuenta_bloqueada");

    if (usuario.otp_activo) {
      await enviarCodigo(usuario, "otp_login", plantillas.codigoOtpLogin, { ignorarCooldown: true });
      return alFront(res, "/login/otp", { email: usuario.email, next });
    }

    await emitirSesion(req, res, usuario);
    return alFront(res, "/auth/google/callback", { next });
  } catch (error) {
    const codigo = error instanceof ErrorGoogle ? error.codigo : "google_error";
    if (!(error instanceof ErrorGoogle) || codigo === "google_codigo_invalido") {
      console.error(`❌ OAuth Google (${codigo}):`, error.message);
    }
    return errorAlLogin(res, error.status === 502 ? "email_no_enviado" : codigo);
  }
};
