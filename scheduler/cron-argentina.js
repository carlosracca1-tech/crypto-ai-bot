'use strict';

/**
 * Scheduler con timing dinámico — Argentina (UTC-3)
 *
 * TWEETS:      6/día — tipos: market, technical (chart), narrative, fundamental, contrarian, market
 * ENGAGEMENT:  2 sesiones de replies/día
 * FOLLOWS:     1 sesión diaria de growth
 * THREADS:     Lunes + Jueves — análisis fundamental en profundidad
 * HEALTH CHECK: 23:00 ART — email diario de estado
 *
 * Todos los tweet/engagement/follow slots tienen horarios ALEATORIOS dentro
 * de ventanas definidas. Se recalculan cada día a las 00:05 ART.
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const { createModuleLogger }  = require('../src/utils/logger');
const { runPipeline }         = require('../src/pipeline');
const { runEngagement }       = require('../src/engagement/engagementManager');
const { runFollowEngine }     = require('../src/growth/followEngine');
const { runDailyHealthCheck } = require('../src/alerts/healthCheck');
const { monitored, installGlobalHandlers } = require('../src/alerts/errorMonitor');
const { config }              = require('../src/config');
const { findRetweetCandidates, retweet } = require('../src/twitter/twitterClient');
const { runLightEngagement }             = require('../src/engagement/lightEngagement');

// ─── Adaptive systems ─────────────────────────────────────────────────────────
let runLiveAdjuster      = async () => {};
let runPerformanceEngine = async () => {};
let runPromptOptimizer   = async () => {};
let refreshDailyCache    = async () => {};

try { runLiveAdjuster      = require('../src/performance/liveAdjuster').runLiveAdjuster;           } catch (e) {}
try { runPerformanceEngine = require('../src/performance/performanceEngine').runPerformanceEngine;  } catch (e) {}
try { runPromptOptimizer   = require('../src/performance/promptOptimizer').runPromptOptimizer;      } catch (e) {}
try { refreshDailyCache    = require('../src/storage/twitterCache').refreshDailyCache;              } catch (e) {}

const log = createModuleLogger('Scheduler-AR');

// ─── TWEET WINDOWS (ART) ───────────────────────────────────────────────────────
//
// 6 slots/día — 2 ciclos de los 3 pilares de contenido + fundamental + contrarian
//
//  Slot 1: 08:00–09:30  →  market_insight
//  Slot 2: 10:30–12:00  →  fundamental_insight  (análisis profundo de proyecto)
//  Slot 3: 13:30–15:00  →  technical_analysis   (+ chart adjunto)
//  Slot 4: 16:30–18:00  →  contrarian           (toma contraria al consenso)
//  Slot 5: 19:00–20:30  →  narrative_insight
//  Slot 6: 21:00–22:30  →  market_insight (segunda pasada del día)
//
// ─── Tweet slot distribution ───────────────────────────────────────────────────
//  Option 1 (all 6):  Visual format — emoji + line breaks in every tweet
//  Option 2 (slots 1 & 3): Chart attached — market_insight + technical_analysis
//  Option 3 (slot 5): Quote tweet — finds a relevant CT tweet + adds sharp commentary
//
const TWEET_WINDOWS = [
  { startH: 8,  startM: 0,  endH: 9,  endM: 30, type: 'market_insight',      label: '📊 Market Insight (+chart)' },
  { startH: 10, startM: 30, endH: 12, endM: 0,  type: 'fundamental_insight', label: '🔬 Fundamental Insight'     },
  { startH: 13, startM: 30, endH: 15, endM: 0,  type: 'technical_analysis',  label: '📈 Technical Analysis (+chart)' },
  { startH: 16, startM: 30, endH: 18, endM: 0,  type: 'contrarian',          label: '⚡ Contrarian Take'         },
  // quote_tweet removido — ahora lo hace lightEngagement con 1 sola búsqueda
  { startH: 21, startM: 0,  endH: 22, endM: 30, type: 'market_insight',      label: '📊 Market Insight (Eve)'    },
];

// ─── LIGHT ENGAGEMENT (ART) — 2 sesiones/día, 1 búsqueda cada una ────────────
//
// Cada sesión hace:  1 search → top followers → quote tweet #1 + reply #2
// Costo total: 2 API reads + 4 writes por día = ULTRA BARATO
//
const LIGHT_ENGAGEMENT_WINDOWS = [
  { startH: 11, startM: 0,  endH: 12, endM: 0,  label: '🎯 Light Engagement AM' },
  { startH: 18, startM: 0,  endH: 19, endM: 30, label: '🎯 Light Engagement PM' },
];

// ─── LEGACY (deshabilitados para ahorrar API) ────────────────────────────────
// Se mantienen definidos por si se quieren reactivar en el futuro
const ENGAGEMENT_WINDOWS = [];   // was: 2 sessions × 15 replies = 30 writes + search reads
const RETWEET_WINDOWS    = [];   // was: 1 session = 2 search reads + 1 write
const FOLLOW_WINDOW      = null; // was: 2 search reads + 15 follow writes

// ─── Constantes ────────────────────────────────────────────────────────────────

const ART_OFFSET_HOURS = -3;
const SCHEDULE_FILE    = path.join(process.cwd(), 'data', 'daily_schedule.json');
const activeTimers     = [];

// ─── Helpers de tiempo ─────────────────────────────────────────────────────────

function utcToART(ts = Date.now()) {
  const d = new Date(ts + ART_OFFSET_HOURS * 3600 * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), hours: d.getUTCHours(), minutes: d.getUTCMinutes() };
}

function artTimeToUTC(hours, minutes) {
  const artNow  = utcToART();
  const artDate = Date.UTC(artNow.year, artNow.month, artNow.day, hours, minutes, 0);
  return artDate - ART_OFFSET_HOURS * 3600 * 1000;
}

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function randomTimeInWindow(startH, startM, endH, endM) {
  const startTotal = startH * 60 + startM;
  const endTotal   = endH   * 60 + endM;
  const chosen     = randInt(startTotal, endTotal);
  return { hours: Math.floor(chosen / 60), minutes: chosen % 60 };
}

function fmt(h, m) { return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; }

// ─── Scheduler diario ─────────────────────────────────────────────────────────

function clearActiveTimers() {
  for (const t of activeTimers) clearTimeout(t);
  activeTimers.length = 0;
}

function scheduleDaySlots() {
  clearActiveTimers();

  const now      = Date.now();
  const artNow   = utcToART(now);
  const dayLabel = `${artNow.day}/${artNow.month + 1}/${artNow.year}`;

  log.info('═'.repeat(60));
  log.info(`HORARIOS DEL DÍA — ${dayLabel} (ART)`);
  log.info('─'.repeat(60));

  const schedule = { date: dayLabel, generatedAt: new Date().toISOString(), slots: [] };

  // ── Tweet slots ─────────────────────────────────────────────────────────────
  for (const win of TWEET_WINDOWS) {
    const { hours, minutes } = randomTimeInWindow(win.startH, win.startM, win.endH, win.endM);
    const fireUTC = artTimeToUTC(hours, minutes);
    const delayMs = fireUTC - now;

    schedule.slots.push({ label: win.label, type: 'tweet', tweetType: win.type, timeART: fmt(hours, minutes), status: delayMs > 0 ? 'scheduled' : 'past' });

    if (delayMs <= 0) {
      log.info(`  ⏭  SKIP  ${win.label.padEnd(24)} ${fmt(hours, minutes)} ART`);
      continue;
    }
    log.info(`  ✓  ${win.label.padEnd(24)} ${fmt(hours, minutes)} ART  (+${Math.round(delayMs / 60000)} min)`);
    activeTimers.push(setTimeout(() => executeTweetSlot(win.label, win.type), delayMs));
  }

  log.info('─'.repeat(60));

  // ── Light Engagement slots (reemplaza engagement + retweet + follow + quote) ─
  for (const win of LIGHT_ENGAGEMENT_WINDOWS) {
    const { hours, minutes } = randomTimeInWindow(win.startH, win.startM, win.endH, win.endM);
    const fireUTC = artTimeToUTC(hours, minutes);
    const delayMs = fireUTC - now;

    schedule.slots.push({ label: win.label, type: 'light_engagement', timeART: fmt(hours, minutes), status: delayMs > 0 ? 'scheduled' : 'past' });

    if (delayMs <= 0) {
      log.info(`  ⏭  SKIP  ${win.label.padEnd(24)} ${fmt(hours, minutes)} ART`);
      continue;
    }
    log.info(`  ✓  ${win.label.padEnd(24)} ${fmt(hours, minutes)} ART  (+${Math.round(delayMs / 60000)} min)`);
    activeTimers.push(setTimeout(() => executeLightEngagementSlot(win.label), delayMs));
  }

  log.info('─'.repeat(60));
  log.info(`Timers activos: ${activeTimers.length}`);
  log.info('═'.repeat(60));

  // Persistir
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
  } catch (e) { log.warn(`No se pudo guardar schedule: ${e.message}`); }
}

// ─── Ejecutores ────────────────────────────────────────────────────────────────

const running = {};

async function executeTweetSlot(label, tweetType) {
  if (running[label]) { log.warn(`${label} ya corre — skip`); return; }
  running[label] = true;

  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  log.info(`\n${'═'.repeat(60)}\nTWEET SLOT: ${label} | ${now}\n${'═'.repeat(60)}`);

  await monitored(`Scheduler:${label}`, async () => {
    const result = await runPipeline({ dryRun: config.content.dryRun, forceRun: true, skipPosting: false, tweetType });
    if (result) {
      const posted = result.publishResults?.filter(r => r.success !== false).length || 0;
      log.info(`✓ ${label} | Publicados: ${posted} | ${result.runSummary?.duration || '?'}`);
    }
  }, { slot: label, tweetType });

  running[label] = false;
}

async function executeEngagementSlot(label) {
  // LEGACY — deshabilitado para ahorrar API. Usar executeLightEngagementSlot
  log.info(`${label} (legacy) — skipped, usando light engagement`);
}

async function executeLightEngagementSlot(label) {
  if (running[label]) { log.warn(`${label} ya corre — skip`); return; }
  running[label] = true;

  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  log.info(`\n${'═'.repeat(60)}\nLIGHT ENGAGEMENT: ${label} | ${now}\n${'═'.repeat(60)}`);

  await monitored(`Scheduler:${label}`, async () => {
    const result = await runLightEngagement({ dryRun: config.content.dryRun });
    log.info(`✓ ${label} | Quote: ${result.quoteTweet ? '✅' : '❌'} | Reply: ${result.reply ? '✅' : '❌'} | API reads: ${result.searchCost}`);
  }, { slot: label });

  running[label] = false;
}

async function executeFollowSlot() {
  const label = FOLLOW_WINDOW.label;
  if (running[label]) { log.warn(`${label} ya corre — skip`); return; }
  running[label] = true;

  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  log.info(`\n${'═'.repeat(60)}\nFOLLOW SESSION | ${now}\n${'═'.repeat(60)}`);

  await monitored('Scheduler:FollowEngine', async () => {
    const result = await runFollowEngine({ dryRun: config.content.dryRun });
    log.info(`✓ Follow session | Seguidos: ${result.followed || 0} | Total día: ${result.followed || 0}`);
  }, { slot: label });

  running[label] = false;
}

async function executeRetweetSlot(label) {
  if (running[label]) { log.warn(`${label} ya corre — skip`); return; }
  running[label] = true;

  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  log.info(`\n${'═'.repeat(60)}\nRETWEET SLOT: ${label} | ${now}\n${'═'.repeat(60)}`);

  await monitored(`Scheduler:${label}`, async () => {
    const dryRun = config.content.dryRun;

    // 1. Buscar candidatos de alta calidad
    const candidates = await findRetweetCandidates({ minLikes: 10, maxResults: 3 });

    if (candidates.length === 0) {
      log.info('No se encontraron candidatos para retweetear');
      return;
    }

    log.info(`${candidates.length} candidatos para RT:`);
    for (const c of candidates) {
      log.info(`  @${c.authorUsername} (${c.likes} likes): "${c.text.substring(0, 80)}..."`);
    }

    // 2. Retweetear el mejor candidato (1 RT por sesión para no spamear)
    const best = candidates[0];
    if (dryRun) {
      log.info(`[DRY RUN] Retweetearía: ${best.id} by @${best.authorUsername}`);
    } else {
      const result = await retweet(best.id);
      if (result) {
        log.info(`✅ Retweeteado: @${best.authorUsername} (${best.likes} likes)`);
      }
    }
  }, { slot: label });

  running[label] = false;
}

async function executeThreadSlot() {
  const label = '📝 Thread Generation';
  if (running[label]) { log.warn(`${label} ya corre — skip`); return; }
  running[label] = true;

  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  log.info(`\n${'═'.repeat(60)}\nTHREAD SLOT | ${now}\n${'═'.repeat(60)}`);

  await monitored('Scheduler:Thread', async () => {
    const result = await runPipeline({ dryRun: config.content.dryRun, forceRun: true, skipPosting: false, includeThread: true, tweetType: null });
    if (result?.thread) {
      log.info(`✓ Thread publicado: ${result.thread.tweetCount} tweets`);
    }
  }, { slot: label });

  running[label] = false;
}

// ─── Start ─────────────────────────────────────────────────────────────────────

function start() {
  // Instalar handlers globales de errores
  installGlobalHandlers();

  // Limpiar bloqueo de Search API al arrancar (por si se compraron créditos y se hizo redeploy)
  try {
    const { clearSearchApiBlock } = require('../src/narrative/twitterScraper');
    if (clearSearchApiBlock()) {
      log.info('🔓 Bloqueo de Search API limpiado al arrancar');
    }
  } catch (e) { /* no-op */ }

  log.info('═'.repeat(60));
  log.info('AI CRYPTO BOT — SISTEMA UNIFICADO ACTIVO (COST-OPTIMIZED)');
  log.info(`Dry run: ${config.content.dryRun}`);
  log.info(`Tweets/día: ${TWEET_WINDOWS.length} | Light Engagement: ${LIGHT_ENGAGEMENT_WINDOWS.length}× (1 search + 1 quote + 1 reply each)`);
  log.info('═'.repeat(60));

  // ── Slots dinámicos del día ─────────────────────────────────────────────────
  scheduleDaySlots();

  // ── Reset diario 00:05 ART (03:05 UTC) ─────────────────────────────────────
  cron.schedule('5 3 * * *', async () => {
    log.info('\n🔄 Reset diario — recalculando horarios...');
    scheduleDaySlots();
    // Cache refresh DESHABILITADO — lightEngagement hace su propia búsqueda (ahorra ~13 API reads)
  }, { scheduled: true, timezone: 'UTC' });

  // ── Threads semanales: Lunes 10:00 ART + Jueves 15:00 ART ──────────────────
  //    Lunes  10:00 ART = 13:00 UTC → '0 13 * * 1'
  //    Jueves 15:00 ART = 18:00 UTC → '0 18 * * 4'
  cron.schedule('0 13 * * 1', () => executeThreadSlot(), { scheduled: true, timezone: 'UTC' });
  cron.schedule('0 18 * * 4', () => executeThreadSlot(), { scheduled: true, timezone: 'UTC' });
  log.info('  📝 Threads: Lunes 10:00 ART + Jueves 15:00 ART');

  // ── Health check diario 23:00 ART (02:00 UTC next day) ─────────────────────
  cron.schedule('0 2 * * *', async () => {
    log.info('\n📊 Ejecutando daily health check...');
    await monitored('HealthCheck', () => runDailyHealthCheck(), {});
  }, { scheduled: true, timezone: 'UTC' });
  log.info('  💊 Health check: 23:00 ART');

  // ── Limpieza semanal domingos 03:00 UTC ─────────────────────────────────────
  cron.schedule('0 3 * * 0', async () => {
    const { cleanupOldFiles } = require('../src/storage/dataStore');
    log.info('Ejecutando limpieza semanal...');
    await cleanupOldFiles(30);

    // Clean up SQLite DB (keep tweets 14 days, metrics 90 days)
    try {
      const { cleanup } = require('../src/storage/twitterDB');
      cleanup(14, 90);
    } catch (e) { log.warn(`DB cleanup skipped: ${e.message}`); }
  }, { scheduled: true, timezone: 'UTC' });

  // ── Live Adjuster: cada 2.5h — detecta virales y ajusta en tiempo real ──────
  // UTC times for every 2.5h roughly: 01:30, 04:00, 06:30, 09:00, 11:30, 14:00, 16:30, 19:00, 21:30
  const LIVE_ADJUSTER_CRONS = ['30 1', '0 4', '30 6', '0 9', '30 11', '0 14', '30 16', '0 19', '30 21'];
  for (const slot of LIVE_ADJUSTER_CRONS) {
    cron.schedule(`${slot} * * *`, async () => {
      log.info(`\n⚡ Live Adjuster ejecutando (${slot} UTC)...`);
      await monitored('LiveAdjuster', () => runLiveAdjuster(), {}, false);
    }, { scheduled: true, timezone: 'UTC' });
  }
  log.info('  ⚡ Live Adjuster: cada ~2.5h');

  // ── Twitter Daily Cache: DESHABILITADO ──────────────────────────────────────
  // Antes: 13 search queries × 2 veces/día = ~26 API reads/día
  // Ahora: lightEngagement hace 1 search × 2 veces/día = 2 API reads/día
  log.info('  🗄️  Twitter Cache: DESHABILITADO (lightEngagement busca directo)');

  // ── Performance Engine: 1×/día at 22:00 UTC (19:00 ART) ──────────────────
  // Reduced from 3x to 1x — tweets need time to accumulate metrics anyway
  cron.schedule('0 22 * * *', async () => {
    log.info('\n📈 Performance Engine ejecutando (22:00 UTC / 19:00 ART)...');
    await monitored('PerformanceEngine', () => runPerformanceEngine(), {}, false);
  }, { scheduled: true, timezone: 'UTC' });
  log.info('  📈 Performance Engine: 1×/día (19:00 ART)');

  // ── Prompt Optimizer: semanal, domingos a las 04:00 UTC ──────────────────────
  cron.schedule('0 4 * * 0', async () => {
    log.info('\n🧠 Prompt Optimizer ejecutando...');
    await monitored('PromptOptimizer', () => runPromptOptimizer(), {}, false);
  }, { scheduled: true, timezone: 'UTC' });
  log.info('  🧠 Prompt Optimizer: domingos 04:00 UTC');

  // ── --run-now testing flag ──────────────────────────────────────────────────
  if (process.argv.includes('--run-now')) {
    const first = TWEET_WINDOWS[0];
    log.info(`--run-now: ejecutando ${first.label} en 3s...`);
    setTimeout(() => executeTweetSlot(first.label, first.type), 3000);
  }

  log.info('─'.repeat(60));
  log.info('Sistema corriendo. Esperando próximos slots...');
  log.info('═'.repeat(60));
}

// ─── Señales ───────────────────────────────────────────────────────────────────

process.on('SIGTERM', () => { log.info('SIGTERM. Cerrando...'); clearActiveTimers(); process.exit(0); });
process.on('SIGINT',  () => { log.info('SIGINT. Cerrando...');  clearActiveTimers(); process.exit(0); });

start();
