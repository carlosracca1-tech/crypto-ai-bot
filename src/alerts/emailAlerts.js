'use strict';

/**
 * Email Alerts — SMTP / SendGrid
 *
 * Env vars (pick one set):
 *   SENDGRID_API_KEY        → usa SendGrid SMTP relay
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS → usa SMTP directo (Gmail, etc.)
 *
 * ALERT_EMAIL → destinatario (default: carlosracca1@gmail.com)
 *
 * Si ningún proveedor está configurado, loggea el email a archivo y no falla.
 */

const path = require('path');
const fs   = require('fs');
const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('EmailAlerts');

// ─── Config ────────────────────────────────────────────────────────────────────

function getEmailConfig() {
  return {
    to:   process.env.ALERT_EMAIL || 'carlosracca1@gmail.com',
    from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER || 'bot@theprotocmind.ai',

    // SendGrid SMTP relay
    sendgridKey: process.env.SENDGRID_API_KEY || null,

    // Direct SMTP
    smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
    smtpUser: process.env.SMTP_USER || null,
    smtpPass: process.env.SMTP_PASS || null,
  };
}

// ─── Transporter factory ───────────────────────────────────────────────────────

let _transporter = null;

async function getTransporter() {
  if (_transporter) return _transporter;

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    log.warn('nodemailer no instalado — emails deshabilitados');
    return null;
  }

  const cfg = getEmailConfig();

  if (cfg.sendgridKey) {
    _transporter = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: cfg.sendgridKey },
    });
    log.info('Email transporter: SendGrid SMTP relay');
    return _transporter;
  }

  if (cfg.smtpUser && cfg.smtpPass) {
    _transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
    });
    log.info(`Email transporter: SMTP ${cfg.smtpHost}:${cfg.smtpPort}`);
    return _transporter;
  }

  log.warn('Email no configurado (SENDGRID_API_KEY o SMTP_USER+SMTP_PASS requeridos)');
  return null;
}

// ─── Fallback: log to file ─────────────────────────────────────────────────────

function logEmailToFile(subject, body) {
  try {
    const logFile = path.join(process.cwd(), 'data', 'email_log.json');
    const entry = { timestamp: new Date().toISOString(), subject, body };
    let entries = [];
    if (fs.existsSync(logFile)) {
      entries = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    }
    entries.unshift(entry);
    entries = entries.slice(0, 100); // keep last 100
    fs.writeFileSync(logFile, JSON.stringify(entries, null, 2));
  } catch (e) {
    log.warn(`No se pudo guardar email log: ${e.message}`);
  }
}

// ─── Send ──────────────────────────────────────────────────────────────────────

/**
 * Envía un email de alerta.
 * @param {string} subject
 * @param {string} htmlBody
 * @param {string} [textBody]
 */
async function sendEmail(subject, htmlBody, textBody = '') {
  const cfg = getEmailConfig();
  log.info(`Enviando email: "${subject}" → ${cfg.to}`);

  const transporter = await getTransporter();

  if (!transporter) {
    log.warn('Sin transporter — email guardado en data/email_log.json');
    logEmailToFile(subject, textBody || htmlBody.replace(/<[^>]+>/g, ''));
    return false;
  }

  try {
    const info = await transporter.sendMail({
      from:    `"TheProtocoMind Bot" <${cfg.from}>`,
      to:      cfg.to,
      subject: `[TheProtocoMind] ${subject}`,
      text:    textBody || htmlBody.replace(/<[^>]+>/g, ''),
      html:    htmlBody,
    });
    log.info(`✅ Email enviado: ${info.messageId}`);
    logEmailToFile(subject, textBody || subject); // also log locally
    return true;
  } catch (err) {
    log.error(`Error enviando email: ${err.message}`);
    logEmailToFile(subject, `SEND FAILED: ${err.message}`);
    return false;
  }
}

// ─── Templates ────────────────────────────────────────────────────────────────

function htmlWrap(title, content, color = '#e63946') {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: monospace; background: #0a0a0a; color: #e0e0e0; margin: 0; padding: 20px; }
  .container { max-width: 640px; margin: 0 auto; }
  .header { background: ${color}22; border-left: 4px solid ${color}; padding: 16px 20px; margin-bottom: 24px; }
  .header h1 { margin: 0; font-size: 18px; color: ${color}; }
  .header .timestamp { font-size: 12px; color: #888; margin-top: 4px; }
  .section { background: #111; border: 1px solid #222; padding: 16px; margin-bottom: 16px; border-radius: 4px; }
  .section h2 { margin: 0 0 12px; font-size: 14px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; }
  .kv { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #1a1a1a; }
  .kv:last-child { border-bottom: none; }
  .kv .key { color: #888; }
  .kv .val { color: #e0e0e0; font-weight: bold; }
  .error { background: #1a0505; border: 1px solid #5c1a1a; padding: 12px; font-size: 12px; color: #ff6b6b; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .ok { color: #51cf66; }
  .warn { color: #ffd43b; }
  .err { color: #ff6b6b; }
  .footer { font-size: 11px; color: #555; margin-top: 24px; text-align: center; }
</style></head>
<body><div class="container">
  <div class="header">
    <h1>🤖 ${title}</h1>
    <div class="timestamp">${new Date().toISOString()} UTC</div>
  </div>
  ${content}
  <div class="footer">TheProtocoMind Bot — @TheProtocoMind</div>
</div></body></html>`;
}

// ─── Alert types ───────────────────────────────────────────────────────────────

/**
 * Alerta de error crítico.
 */
async function sendErrorAlert({ module, error, stack, context = {} }) {
  const subject = `❌ ERROR — ${module}`;

  const ctx = Object.entries(context).map(([k, v]) =>
    `<div class="kv"><span class="key">${k}</span><span class="val">${v}</span></div>`
  ).join('');

  const suggestedCause = guessCause(error, module);

  const html = htmlWrap(`Error en ${module}`, `
    <div class="section">
      <h2>Error</h2>
      <div class="kv"><span class="key">Módulo</span><span class="val err">${module}</span></div>
      <div class="kv"><span class="key">Mensaje</span><span class="val err">${error}</span></div>
      <div class="kv"><span class="key">Timestamp</span><span class="val">${new Date().toISOString()}</span></div>
    </div>
    ${ctx ? `<div class="section"><h2>Contexto</h2>${ctx}</div>` : ''}
    ${suggestedCause ? `<div class="section"><h2>Causa probable</h2><p>${suggestedCause}</p></div>` : ''}
    <div class="section">
      <h2>Stack Trace</h2>
      <div class="error">${(stack || 'No stack trace').replace(/</g, '&lt;')}</div>
    </div>
  `);

  return sendEmail(subject, html);
}

/**
 * Daily health report.
 */
async function sendHealthReport(stats) {
  const statusColor = stats.status === 'OK' ? '#51cf66' : stats.status === 'DEGRADED' ? '#ffd43b' : '#ff6b6b';
  const subject = `${stats.status === 'OK' ? '✅' : stats.status === 'DEGRADED' ? '⚠️' : '❌'} Daily Health — ${stats.date}`;

  const tweetsHtml = stats.tweets.map(t =>
    `<div class="kv"><span class="key">${t.type}</span><span class="val ${t.posted ? 'ok' : 'warn'}">${t.posted ? '✅ Posted' : '❌ Failed'}</span></div>`
  ).join('');

  const warningsHtml = stats.warnings?.length
    ? `<div class="section"><h2>⚠️ Warnings</h2>${stats.warnings.map(w => `<div class="kv"><span class="key">${w}</span></div>`).join('')}</div>`
    : '';

  const errorsHtml = stats.errors?.length
    ? `<div class="section"><h2>❌ Errors</h2><div class="error">${stats.errors.join('\n')}</div></div>`
    : '';

  const html = htmlWrap(`Daily Health — ${stats.date}`, `
    <div class="section">
      <h2>Estado del Sistema</h2>
      <div class="kv"><span class="key">Status</span><span class="val" style="color:${statusColor}">${stats.status}</span></div>
      <div class="kv"><span class="key">Tweets publicados</span><span class="val ok">${stats.tweetsPosted} / ${stats.tweetsScheduled}</span></div>
      <div class="kv"><span class="key">Replies generados</span><span class="val">${stats.repliesPosted}</span></div>
      <div class="kv"><span class="key">Follows realizados</span><span class="val">${stats.followsToday || 0}</span></div>
      <div class="kv"><span class="key">Errores</span><span class="val ${stats.errorCount > 0 ? 'err' : 'ok'}">${stats.errorCount}</span></div>
      <div class="kv"><span class="key">Fecha</span><span class="val">${stats.date} (ART)</span></div>
    </div>
    ${tweetsHtml ? `<div class="section"><h2>Tweets del Día</h2>${tweetsHtml}</div>` : ''}
    ${warningsHtml}
    ${errorsHtml}
  `, statusColor);

  return sendEmail(subject, html);
}

// ─── Diagnosis helpers ─────────────────────────────────────────────────────────

function guessCause(errorMsg, moduleName) {
  const msg = String(errorMsg).toLowerCase();
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid token')) {
    return 'Token expirado o credenciales inválidas. Verificar TWITTER_ACCESS_TOKEN / TWITTER_APP_KEY en Railway Variables.';
  }
  if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit')) {
    return 'Rate limit de la API alcanzado. El sistema reintentará en el próximo ciclo.';
  }
  if (msg.includes('openai') || msg.includes('api key') || msg.includes('billing')) {
    return 'Problema con OpenAI API. Verificar OPENAI_API_KEY y estado de créditos en platform.openai.com.';
  }
  if (msg.includes('coingecko') || msg.includes('fetch') || msg.includes('network') || msg.includes('econnrefused')) {
    return 'Error de red o API externa caída. CoinGecko puede estar experimentando downtime.';
  }
  if (msg.includes('cannot read') || msg.includes('undefined') || msg.includes('null')) {
    return 'Datos faltantes o en formato inesperado — posiblemente la API devolvió respuesta vacía o incompleta.';
  }
  if (moduleName?.includes('Chart') || msg.includes('canvas')) {
    return 'Error generando chart. El módulo canvas puede fallar si los datos OHLC están vacíos.';
  }
  return null;
}

module.exports = { sendEmail, sendErrorAlert, sendHealthReport };
