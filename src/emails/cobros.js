// src/emails/cobros.js — plantillas de cobros y pagos.
import { boton, escapeHtml, layout } from "./layout.js";

const hola = (name) => `<p>Hola ${escapeHtml(String(name || "").split(" ")[0])},</p>`;
const tabla = (filas) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.8;margin:12px 0;">${filas
    .map(([k, v]) => `<tr><td style="color:#71717a;padding-right:14px;">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join("")}</table>`;

export const cobroRecordatorio = ({ name, codigo, concepto, importe, fecha, urlCta, textoCta }) => ({
  subject: `Recordatorio: tu pago de ${importe} vence el ${fecha}`,
  text: `Te recordamos que el ${fecha} vence tu pago ${codigo} (${concepto}) por ${importe}. Cuando pagues, puedes adjuntar el comprobante en tu área de cliente: ${urlCta}`,
  html: layout({
    titulo: "Recordatorio de pago",
    preheader: `${importe} · vence el ${fecha}`,
    contenido: `${hola(name)}
      <p>Te recordamos que se acerca la fecha de tu próximo pago:</p>
      ${tabla([["Concepto", concepto], ["Valor", importe], ["Fecha de pago", fecha], ["Referencia", codigo]])}
      <p>Cuando lo realices, puedes adjuntar el comprobante desde tu área de cliente para que lo registremos.</p>
      ${boton(urlCta, textoCta)}
      <p style="color:#71717a;font-size:13px;">Si ya realizaste el pago, ignora este mensaje.</p>`,
  }),
});

export const cobroVencido = ({ name, codigo, concepto, importe, fecha, urlCta, textoCta }) => ({
  subject: `Tu pago de ${importe} está pendiente`,
  text: `El pago ${codigo} (${concepto}) por ${importe} venció el ${fecha} y aún no lo tenemos registrado. Si ya pagaste, adjunta el comprobante: ${urlCta}`,
  html: layout({
    titulo: "Pago pendiente",
    preheader: `${importe} · venció el ${fecha}`,
    contenido: `${hola(name)}
      <p>El siguiente pago venció y todavía no lo tenemos registrado:</p>
      ${tabla([["Concepto", concepto], ["Valor", importe], ["Fecha de pago", fecha], ["Referencia", codigo]])}
      <p>Si ya lo realizaste, adjunta el comprobante desde tu área de cliente y lo confirmaremos. Si tienes alguna dificultad, responde a este email.</p>
      ${boton(urlCta, textoCta)}`,
  }),
});

export const comprobanteEquipo = ({ cliente, codigo, concepto, importe, via, url }) => ({
  subject: `${cliente} subió un comprobante · ${codigo}`,
  text: `${cliente} subió un comprobante para ${codigo} (${concepto}): ${importe} por ${via}. Revísalo: ${url}`,
  html: layout({
    titulo: "Comprobante por verificar",
    preheader: `${cliente} · ${importe}`,
    contenido: `<p><strong>${escapeHtml(cliente)}</strong> subió un comprobante de pago.</p>
      ${tabla([["Cobro", `${codigo} · ${concepto}`], ["Valor", importe], ["Medio", via]])}
      ${boton(url, "Revisar y confirmar")}`,
  }),
});

export const pagoRechazado = ({ name, codigo, concepto, motivo, urlCta }) => ({
  subject: `No pudimos confirmar tu pago · ${codigo}`,
  text: `No pudimos confirmar el comprobante de ${codigo} (${concepto}). Motivo: ${motivo}. Puedes subir otro desde tu área de cliente: ${urlCta}`,
  html: layout({
    titulo: "Pago no confirmado",
    preheader: codigo,
    contenido: `${hola(name)}
      <p>Revisamos el comprobante que adjuntaste para <strong>${escapeHtml(concepto)}</strong> (${escapeHtml(codigo)}) y no pudimos confirmarlo.</p>
      <div style="margin:16px 0;padding:14px 16px;background:#f4f4f5;border-left:3px solid #00a49c;">${escapeHtml(motivo)}</div>
      <p>Puedes subir otro comprobante desde tu área de cliente o responder a este email.</p>
      ${boton(urlCta, "Ir a mis pagos")}`,
  }),
});

/** Bienvenida formal al dar de alta a un cliente con su espacio en la web. */
export const bienvenidaCliente = ({ name, empresa, proyecto, email, urlCta, textoCta, tieneCuenta }) => ({
  subject: `Bienvenido a tu espacio de cliente en Seventwo`,
  text: `${empresa}: ya tienes tu espacio de cliente en seventwo.tech. Allí encontrarás tu servicio (${proyecto}), tu contrato, tus pagos mes a mes y podrás adjuntar los comprobantes. ${tieneCuenta ? "Entra con tu cuenta" : `Crea tu cuenta con el correo ${email}`}: ${urlCta}`,
  html: layout({
    titulo: "Tu espacio de cliente",
    preheader: `${empresa} · todo tu servicio en un solo lugar`,
    contenido: `${hola(name)}
      <p>En Seventwo Technologies queremos agradecerte la confianza. A partir de hoy, <strong>${escapeHtml(empresa)}</strong> cuenta con un espacio propio en nuestra web desde el que podrás consultar toda la información de tu servicio:</p>
      <ul style="padding-left:18px;line-height:1.8;">
        <li><strong>Tu servicio contratado:</strong> ${escapeHtml(proyecto)}, con su estado y detalles.</li>
        <li><strong>Tu contrato</strong>, disponible para consultarlo cuando lo necesites.</li>
        <li><strong>Tus pagos mes a mes</strong>, con su estado, y la opción de <strong>adjuntar el comprobante</strong> de cada pago.</li>
        <li><strong>Notificaciones</strong> con recordatorios de pago y novedades de tu servicio.</li>
      </ul>
      <p>${tieneCuenta
        ? "Ya tienes una cuenta con este correo: solo tienes que iniciar sesión."
        : `Para entrar, crea tu cuenta con este mismo correo (<strong>${escapeHtml(email)}</strong>). Al verificarlo, tu espacio quedará vinculado automáticamente.`}</p>
      ${boton(urlCta, textoCta)}
      <p>Si tienes cualquier duda, responde a este email y con gusto te ayudamos.</p>
      <p>Cordialmente,<br><strong>Equipo Seventwo Technologies</strong></p>`,
  }),
});
