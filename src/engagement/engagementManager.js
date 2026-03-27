'use strict';

/**
 * Engagement Manager
 *
 * Orquesta el módulo de engagement diario:
 *   1. Carga el estado de hoy (log de respuestas)
 *   2. Busca tweets candidatos
 *   3. Genera respuestas contextuales con GPT
 *   4. Publica respuestas con límites anti-spam
 *   5. Persiste el log actualizado
 *
 * Límites:
 *   - Máx DAILY_REPLY_LIMIT respuestas por día
 *   - No responder a la misma cuenta más de 1 vez por día
 *   - No responder al mismo tweet ID dos veces nunca
 */

const fs   = require('fs');
const path = require('path');

const { discoverTweets }    = require('./tweetDiscovery');
const { generateValidReply } = require('./replyGenerator');
const { postTweet }         = require('../twitter/twitterClient');
const { config }            = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { sleep }             = require('../utils/retry');

const log = createModuleLogger('EngagementManager');

// ─── Config ────────────────────────────────────────────────────────────────────

const DAILY_REPLY_LIMIT  = 15;   // respuestas máximas por día
const DELAY_BETWEEN_MS   = 8000; // pausa entre cada reply (8 segundos)
const LOG_FILE = path.join(process.cwd(), 'data', 'engagement_log.json');

// ─── Persistencia del log ──────────────────────────────────────────────────────

function loadLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return { date: null, replies: [] };
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { date: null, replies: [] };
  }
}

function saveLog(data) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log.error(`Error guardando engagement log: ${err.message}`);
  }
}

/**
 * Devuelve el log del día actual. Si el log es de otro día, lo resetea.
 */
function getTodayLog() {
  const stored = loadLog();
  const today  = new Date().toISOString().split('T')[0];

  if (stored.date !== today) {
    log.info(`Nuevo día (${today}) — reseteando log de engagement`);
    return { date: today, replies: [] };
  }

  log.info(`Log del día cargado: ${stored.replies.length} respuestas previas`);
  return stored;
}

// ─── Verificación de límites ───────────────────────────────────────────────────

function hasRepliedToTweet(log, tweetId) {
  return log.replies.some(r => r.tweetId === tweetId);
}

function hasRepliedToAuthor(log, authorHandle) {
  return log.replies.some(
    r => r.authorHandle?.toLowerCase() === authorHandle?.toLowerCase()
  );
}

function dailyLimitReached(log) {
  return log.replies.length >= DAILY_REPLY_LIMIT;
}

// ─── Pipeline principal ────────────────────────────────────────────────────────

/**
 * Ejecuta el módulo de engagement completo.
 * @param {object} opts
 * @param {boolean} opts.dryRun - Si true, no postea (solo loggea)
 * @returns {Promise<object>} Resumen de ejecución
 */
async function runEngagement(opts = {}) {
  // COST CONTROL: Skip when reads disabled (needs search to find tweets to engage with)
  if (config.twitter.readsDisabled) {
    log.info('⚡ READS_DISABLED — skipping engagement module (requires search)');
    return { replied: 0, skipped: 'reads_disabled' };
  }

  const dryRun = opts.dryRun ?? config.content.dryRun;

  log.info('═'.repeat(55));
  log.info('ENGAGEMENT MODULE INICIADO');
  log.info(`Modo: ${dryRun ? 'DRY RUN' : 'LIVE'} | Límite: ${DAILY_REPLY_LIMIT} replies/día`);
  log.info('═'.repeat(55));

  const todayLog    = getTodayLog();
  const alreadyReplied = todayLog.replies.map(r => r.tweetId);

  if (dailyLimitReached(todayLog)) {
    log.info(`Límite diario alcanzado (${DAILY_REPLY_LIMIT}). Skipping.`);
    return { skipped: true, reason: 'daily_limit', count: todayLog.replies.length };
  }

  const remaining = DAILY_REPLY_LIMIT - todayLog.replies.length;
  log.info(`Slots disponibles hoy: ${remaining}`);

  // ── 1. Descubrir tweets ─────────────────────────────────────────────────────
  let candidates;
  try {
    candidates = await discoverTweets(alreadyReplied);
  } catch (err) {
    log.error(`Error en tweetDiscovery: ${err.message}`);
    return { error: err.message, replies: 0 };
  }

  if (!candidates.length) {
    log.warn('No se encontraron candidatos relevantes hoy');
    return { replies: 0, reason: 'no_candidates' };
  }

  log.info(`${candidates.length} candidatos disponibles`);

  // ── 2. Filtrar y generar respuestas ────────────────────────────────────────

  const results = { posted: 0, skipped: 0, errors: 0, replies: [] };
  let processed = 0;

  for (const tweet of candidates) {
    if (dailyLimitReached(todayLog)) {
      log.info('Límite diario alcanzado durante la sesión. Deteniendo.');
      break;
    }

    // Filtros de estado
    if (hasRepliedToTweet(todayLog, tweet.id)) {
      results.skipped++;
      continue;
    }
    if (hasRepliedToAuthor(todayLog, tweet.authorHandle)) {
      log.info(`  Skipping @${tweet.authorHandle} — ya respondido hoy`);
      results.skipped++;
      continue;
    }

    processed++;
    log.info(`\n[${processed}] @${tweet.authorHandle} (${formatNum(tweet.authorFollowers)} followers | ${tweet.likes} likes)`);
    log.info(`  Tweet: "${tweet.text.substring(0, 100)}${tweet.text.length > 100 ? '...' : ''}"`);

    // ── Generar respuesta ──────────────────────────────────────────────────
    let replyText;
    try {
      replyText = await generateValidReply(tweet);
    } catch (err) {
      log.error(`  Error generando reply: ${err.message}`);
      results.errors++;
      continue;
    }

    if (!replyText) {
      log.warn('  No se pudo generar una respuesta válida, skipping');
      results.skipped++;
      continue;
    }

    log.info(`  Reply: "${replyText}"`);

    // ── Publicar respuesta ─────────────────────────────────────────────────
    if (!dryRun) {
      try {
        const posted = await postTweet(replyText, null, tweet.id);

        // Actualizar log
        todayLog.replies.push({
          tweetId:      tweet.id,
          authorHandle: tweet.authorHandle,
          authorFollowers: tweet.authorFollowers,
          replyId:      posted.id,
          replyText,
          postedAt:     new Date().toISOString(),
          score:        Math.round(tweet.score * 100) / 100,
        });
        saveLog(todayLog);

        results.posted++;
        results.replies.push({ tweetId: tweet.id, replyId: posted.id, author: tweet.authorHandle });
        log.info(`  ✅ Reply publicado! ID: ${posted.id}`);

        await sleep(DELAY_BETWEEN_MS);
      } catch (err) {
        log.error(`  ❌ Error publicando reply: ${err.message}`);
        results.errors++;
        // Si es rate limit, parar todo
        if (err.code === 429 || err.message?.includes('429') || err.message?.includes('Too Many Requests')) {
          log.error('Rate limit de posting alcanzado — deteniendo engagement por hoy');
          break;
        }
      }
    } else {
      // Dry run — solo loggear
      log.info('  [DRY RUN] Reply NO publicado');
      todayLog.replies.push({
        tweetId:      tweet.id,
        authorHandle: tweet.authorHandle,
        replyText,
        dryRun:       true,
        postedAt:     new Date().toISOString(),
      });
      saveLog(todayLog);
      results.posted++;
      await sleep(500);
    }
  }

  // ── 3. Resumen ──────────────────────────────────────────────────────────────
  log.info('\n' + '═'.repeat(55));
  log.info(`ENGAGEMENT COMPLETADO`);
  log.info(`  Publicados: ${results.posted} | Skipped: ${results.skipped} | Errores: ${results.errors}`);
  log.info(`  Total del día: ${todayLog.replies.length}/${DAILY_REPLY_LIMIT}`);
  log.info('═'.repeat(55));

  return results;
}

function formatNum(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

module.exports = { runEngagement };
