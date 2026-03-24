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
    from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER || 'onboarding@resend.dev',

    // Priority 1: Resend HTTP API (works on Railway — no SMTP port needed)
    resendKey: process.env.RESEND_API_KEY || null,

    // Priority 2: SendGrid SMTP relay
    sendgridKey: process.env.SENDGRID_API_KEY || null,

    // Priority 3: Direct SMTP (Gmail, etc.) — NOTE: Railway blocks port 587
    smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
    smtpUser: process.env.SMTP_USER || null,
    smtpPass: process.env.SMTP_PASS || null,
  };
}

// ─── Resend HTTP API (no SMTP, works on Railway) ──────────────────────────────

async function sendViaResend(cfg, mailOptions) {
  const https = require('https');
  const payload = JSON.stringify({
    from:    mailOptions.from,
    to:      [mailOptions.to],
    subject: mailOptions.subject,
    html:    mailOptions.html,
    text:    mailOptions.text,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${cfg.resendKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch { resolve({ id: 'ok' }); }
        } else {
          reject(new Error(`Resend API error ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Resend request timeout')); });
    req.write(payload);
    req.end();
  });
}

// ─── Transporter factory (nodemailer — SendGrid or direct SMTP) ───────────────

let _transporter = null;

async function getTransporter() {
  if (_transporter) return _transporter;

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    log.warn('nodemailer no instalado — emails via Resend o deshabilitados');
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
    const port = cfg.smtpPort;
    _transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port,
      secure: port === 465,
      auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000,
      greetingTimeout:   10000,
      socketTimeout:     15000,
    });
    log.info(`Email transporter: SMTP ${cfg.smtpHost}:${port}`);
    return _transporter;
  }

  return null;
}

// ─── Startup diagnostic ───────────────────────────────────────────────────────

function logEmailProviderStatus() {
  const cfg = getEmailConfig();
  if (cfg.resendKey) {
    log.info(`📧 Email provider: Resend API (HTTP) → ${cfg.to}`);
  } else if (cfg.sendgridKey) {
    log.info(`📧 Email provider: SendGrid SMTP → ${cfg.to}`);
  } else if (cfg.smtpUser && cfg.smtpPass) {
    log.warn(`📧 Email provider: SMTP ${cfg.smtpHost}:${cfg.smtpPort} — WARNING: Railway bloquea puertos SMTP. Configura RESEND_API_KEY.`);
  } else {
    log.warn('📧 Email provider: NONE — configura RESEND_API_KEY en Railway para recibir alertas');
  }
}

// Ejecutar al cargar el módulo
logEmailProviderStatus();

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

  const mailOptions = {
    from:    `"TheProtocoMind Bot" <${cfg.from}>`,
    to:      cfg.to,
    subject: `[TheProtocoMind] ${subject}`,
    text:    textBody || htmlBody.replace(/<[^>]+>/g, ''),
    html:    htmlBody,
  };

  // ── Priority 1: Resend HTTP API ──────────────────────────────────────────
  if (cfg.resendKey) {
    try {
      const result = await sendViaResend(cfg, mailOptions);
      log.info(`✅ Email enviado via Resend: ${result.id}`);
      logEmailToFile(subject, textBody || subject);
      return true;
    } catch (err) {
      log.error(`Error Resend: ${err.message}`);
      logEmailToFile(subject, `RESEND FAILED: ${err.message}`);
      return false;
    }
  }

  // ── Priority 2 & 3: nodemailer (SendGrid o SMTP directo) ─────────────────
  const transporter = await getTransporter();

  if (!transporter) {
    log.warn('Sin proveedor de email configurado — guardado en data/email_log.json');
    log.warn('👉 Solución: agrega RESEND_API_KEY en Railway Variables (gratis en resend.com)');
    logEmailToFile(subject, textBody || htmlBody.replace(/<[^>]+>/g, ''));
    return false;
  }

  try {
    const info = await transporter.sendMail(mailOptions);
    log.info(`✅ Email enviado: ${info.messageId}`);
    logEmailToFile(subject, textBody || subject);
    return true;
  } catch (err) {
    log.error(`Error enviando email (${cfg.smtpHost}:${cfg.smtpPort}): ${err.message}`);
    if (err.message.includes('timeout') || err.message.includes('ECONNREFUSED')) {
      log.error('👉 Railway bloquea SMTP. Usa RESEND_API_KEY (resend.com) o SENDGRID_API_KEY');
    }
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

// ─── Daily Growth Intelligence Report ────────────────────────────────────────

/**
 * Analytical daily report: what worked, what failed, what changes.
 */
async function sendGrowthIntelligenceReport(reportData = {}) {
  const { patterns = {}, strategy = {}, liveAdjusterStats = {}, date = new Date().toISOString().split('T')[0] } = reportData;

  const subject  = `Daily Growth Intelligence — ${date}`;
  const bestType = patterns.best_type || 'N/A';
  const worstType = patterns.worst_type || 'N/A';

  const bestTweet  = patterns.best_tweet;
  const worstTweet = patterns.worst_tweet;

  const typeScores = Object.entries(patterns.by_type || {})
    .sort(([, a], [, b]) => b.avg_score - a.avg_score)
    .map(([type, d]) => `<div class="kv"><span class="key">${type}</span><span class="val ${d.avg_score > (patterns.avg_score || 0) ? 'ok' : 'warn'}">${d.avg_score.toFixed(1)} (n=${d.count})</span></div>`)
    .join('');

  const recommendation = patterns.trend === 'improving'
    ? 'System improving — maintain current strategy.'
    : patterns.trend === 'degrading'
    ? 'Engagement declining — increase contrarian/provocative content ratio.'
    : 'Performance stable — run prompt optimizer for incremental gains.';

  const html = htmlWrap(`Daily Growth Intelligence — ${date}`, `
    <div class="section">
      <h2>📊 ENGAGEMENT SUMMARY</h2>
      <div class="kv"><span class="key">Total tweets tracked</span><span class="val">${patterns.total_tweets || 0}</span></div>
      <div class="kv"><span class="key">Overall avg score</span><span class="val">${(patterns.avg_score || 0).toFixed(1)}</span></div>
      <div class="kv"><span class="key">Trend</span><span class="val ${patterns.trend === 'improving' ? 'ok' : patterns.trend === 'degrading' ? 'err' : 'warn'}">${patterns.trend || 'unknown'}</span></div>
    </div>
    <div class="section">
      <h2>✅ WHAT IS WORKING</h2>
      <div class="kv"><span class="key">Best type</span><span class="val ok">${bestType} (${patterns.by_type?.[bestType]?.avg_score?.toFixed(1) || '?'})</span></div>
      <div class="kv"><span class="key">Best time window</span><span class="val ok">${patterns.best_time_window || 'N/A'}</span></div>
      <div class="kv"><span class="key">Top tokens</span><span class="val ok">${(patterns.top_tokens || []).join(', ') || 'N/A'}</span></div>
      ${bestTweet ? `<div class="kv"><span class="key">Best tweet (score ${bestTweet.metrics?.engagement_score?.toFixed(1)})</span><span class="val" style="font-size:11px">"${(bestTweet.content || '').substring(0, 150)}"</span></div>` : ''}
    </div>
    <div class="section">
      <h2>❌ WHAT IS FAILING</h2>
      <div class="kv"><span class="key">Worst type</span><span class="val err">${worstType} (${patterns.by_type?.[worstType]?.avg_score?.toFixed(1) || '?'})</span></div>
      ${worstTweet ? `<div class="kv"><span class="key">Worst tweet (score ${worstTweet.metrics?.engagement_score?.toFixed(1)})</span><span class="val err" style="font-size:11px">"${(worstTweet.content || '').substring(0, 150)}"</span></div>` : ''}
    </div>
    <div class="section">
      <h2>🔄 WHAT WE CHANGED TODAY</h2>
      <div class="kv"><span class="key">Reason</span><span class="val">${strategy.reason || 'No changes'}</span></div>
      <div class="kv"><span class="key">Preferred types</span><span class="val ok">${(strategy.preferred_types || []).join(', ') || 'default'}</span></div>
      <div class="kv"><span class="key">Tone</span><span class="val">${strategy.tone || 'default'}</span></div>
      <div class="kv"><span class="key">Focus tokens</span><span class="val ok">${(strategy.focus_tokens || []).join(', ') || 'default'}</span></div>
      ${liveAdjusterStats.followups > 0 ? `<div class="kv"><span class="key">Follow-up tweets sent</span><span class="val ok">${liveAdjusterStats.followups}</span></div>` : ''}
    </div>
    <div class="section">
      <h2>📈 ALL TYPES BY SCORE</h2>
      ${typeScores || '<div class="kv"><span class="key">No data yet</span></div>'}
    </div>
    <div class="section">
      <h2>🔮 WHAT CHANGES TOMORROW</h2>
      <p style="color:#e0e0e0">${recommendation}</p>
    </div>
  `, '#6c63ff');

  return sendEmail(subject, html);
}

/**
 * Performance degradation alert — triggered when engagement drops >30% vs prior period.
 */
async function sendPerformanceDegradationAlert({ today_avg, yesterday_avg, suspected_cause, top_failures = [] } = {}) {
  const drop    = yesterday_avg > 0 ? ((today_avg - yesterday_avg) / yesterday_avg * 100).toFixed(1) : '?';
  const subject = `⚠️ Performance Degradation — ${new Date().toISOString().split('T')[0]}`;

  const failuresHtml = top_failures
    .map(f => `<div class="kv"><span class="key">${f.type || '?'}</span><span class="val err">score: ${f.score?.toFixed(1) || '?'}</span></div>`)
    .join('');

  const html = htmlWrap('Performance Degradation Detected', `
    <div class="section">
      <h2>📉 Engagement Drop</h2>
      <div class="kv"><span class="key">Today avg</span><span class="val err">${(today_avg || 0).toFixed(1)}</span></div>
      <div class="kv"><span class="key">Yesterday avg</span><span class="val">${(yesterday_avg || 0).toFixed(1)}</span></div>
      <div class="kv"><span class="key">Change</span><span class="val err">${drop}%</span></div>
    </div>
    ${failuresHtml ? `<div class="section"><h2>Worst Performers</h2>${failuresHtml}</div>` : ''}
    <div class="section">
      <h2>Suspected Cause</h2>
      <p>${suspected_cause || 'No specific cause identified. Check content quality and posting times.'}</p>
      <p>Actions: increase contrarian content | run prompt optimizer | verify API health.</p>
    </div>
  `, '#ffd43b');

  return sendEmail(subject, html);
}

module.exports = {
  sendEmail,
  sendErrorAlert,
  sendHealthReport,
  sendGrowthIntelligenceReport,
  sendPerformanceDegradationAlert,
};
