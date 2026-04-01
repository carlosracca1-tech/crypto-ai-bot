'use strict';

/**
 * Scheduler v3 — COST-OPTIMIZED (target: <$10/mes total)
 *
 * ═══════════════════════════════════════════════════════════
 * TWEETS:        3/día — calidad > cantidad
 *   Slot 1: 09:00–10:30 ART  →  market_insight (+chart)
 *   Slot 2: 14:00–15:30 ART  →  technical_analysis (+chart)
 *   Slot 3: 20:00–21:30 ART  →  contrarian / narrative
 *
 * THREADS:       1×/semana (Jueves)
 * HEALTH CHECK:  23:00 ART
 * CLEANUP:       Domingos 03:00 UTC
 * ═══════════════════════════════════════════════════════════
 *
 * COSTOS:
 *   Twitter Free tier:  $0   (solo writes, 3 tweets/día = 90/mes < 1500 límite)
 *   OpenAI GPT-4o-mini: ~$1-2/mes
 *   CoinGecko free:     $0
 *   Hosting:            ~$5/mes
 *   TOTAL:              ~$6-7/mes
 *
 * ELIMINADO (ahorra $100+/mes):
 *   ❌ Twitter reads/search (requiere plan Basic $100/mes)
 *   ❌ Light Engagement (requiere Twitter search API)
 *   ❌ Follow Engine (requiere Twitter search API)
 *   ❌ Live Adjuster (9 crons innecesarios)
 *   ❌ Quality Gate GPT (reemplazado por validación local gratis)
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const { createModuleLogger }  = require('../src/utils/logger');
const { runPipeline }         = require('../src/pipeline');
const { runDailyHealthCheck } = require('../src/alerts/healthCheck');
const { monitored, installGlobalHandlers } = require('../src/alerts/errorMonitor');
const { config }              = require('../src/config');
const { enableLeakDetection, generateDailySummary } = require('../src/lib/twitterSafeClient');
const { forceRefresh, checkTokenHealth } = require('../src/utils/tokenManager');

// ─── Adaptive systems (non-blocking) ────────────────────────────────────────
let runPerformanceEngine = async () => {};
let runPromptOptimizer   = async () => {};

try { runPerformanceEngine = require('../src/performance/performanceEngine').runPerformanceEngine; } catch (e) { /* optional */ }
try { runPromptOptimizer   = require('../src/performance/promptOptimizer').runPromptOptimizer;     } catch (e) { /* optional */ }

const log = createModuleLogger('Scheduler-AR');

// ─── 3 TWEET WINDOWS (ART) ─────────────────────────────────────────────────
//
//  Mañana:  market_insight   — overview del mercado + chart
//  Tarde:   technical_analysis — señales técnicas + chart
//  Noche:   contrarian         — toma contraria al consenso (alterna con narrative)
//
const TWEET_WINDOWS = [
  { startH: 9,  startM: 0,  endH: 10, endM: 30, type: 'market_insight',     label: '📊 Market Insight (+chart)' },
  { startH: 14, startM: 0,  endH: 15, endM: 30, type: 'technical_analysis', label: '📈 Technical Analysis (+chart)' },
  { startH: 20, startM: 0,  endH: 21, endM: 30, type: 'contrarian',         label: '⚡ Contrarian Take' },
];

// ─── Constantes ─────────────────────────────────────────────────────────────

const ART_OFFSET_HOURS = -3;
const SCHEDULE_FILE    = path.join(process.cwd(), 'data', 'daily_schedule.json');
const activeTimers     = [];

// ─── Helpers de tiempo ──────────────────────────────────────────────────────

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

// ─── Scheduler diario ──────────────────────────────────────────────────────

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

  // ── Tweet slots (3/día) ──────────────────────────────────────────────────
  for (const win of TWEET_WINDOWS) {
    const { hours, minutes } = randomTimeInWindow(win.startH, win.startM, win.endH, win.endM);
    const fireUTC = artTimeToUTC(hours, minutes);
    const delayMs = fireUTC - now;

    schedule.slots.push({
      label: win.label,
      type: 'tweet',
      tweetType: win.type,
      timeART: fmt(hours, minutes),
      status: delayMs > 0 ? 'scheduled' : 'past',
    });

    if (delayMs <= 0) {
      log.info(`  ⏭  SKIP  ${win.label.padEnd(30)} ${fmt(hours, minutes)} ART`);
      continue;
    }
    log.info(`  ✓  ${win.label.padEnd(30)} ${fmt(hours, minutes)} ART  (+${Math.round(delayMs / 60000)} min)`);
    activeTimers.push(setTimeout(() => executeTweetSlot(win.label, win.type), delayMs));
  }

  log.info('─'.repeat(60));
  log.info(`Timers activos: ${activeTimers.length}`);
  log.info('═'.repeat(60));

  // Persistir schedule
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
  } catch (e) { log.warn(`No se pudo guardar schedule: ${e.message}`); }
}

// ─── Ejecutores ─────────────────────────────────────────────────────────────

const running = {};

async function executeTweetSlot(label, tweetType) {
  if (running[label]) { log.warn(`${label} ya corre — skip`); return; }
  running[label] = true;

  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  log.info(`\n${'═'.repeat(60)}\nTWEET SLOT: ${label} | ${now}\n${'═'.repeat(60)}`);

  try {
    await monitored(`Scheduler:${label}`, async () => {
      const result = await runPipeline({
        dryRun: config.content.dryRun,
        forceRun: true,
        skipPosting: false,
        tweetType,
      });
      if (result) {
        const posted = result.publishResults?.filter(r => r.success !== false).length || 0;
        log.info(`✓ ${label} | Publicados: ${posted} | ${result.runSummary?.duration || '?'}`);
      }
    }, { slot: label, tweetType });
  } catch (err) {
    log.error(`Error en slot ${label}: ${err.message}`);
  }

  running[label] = false;
}

// ─── Start ──────────────────────────────────────────────────────────────────

async function start() {
  installGlobalHandlers();

  // ── FASE 8: Activar detección de fugas de Twitter API READ ────────────────
  enableLeakDetection();

  log.info('═'.repeat(60));
  log.info('AI CRYPTO BOT v3 — COST-OPTIMIZED (<$10/mes)');
  log.info(`Modelo: ${config.openai.model}`);
  log.info(`Tweets/día: ${TWEET_WINDOWS.length}`);
  log.info(`Twitter reads: ${config.twitter.readsDisabled ? 'DISABLED (Free tier $0)' : 'ENABLED (Basic $100/mes)'}`);
  log.info(`Twitter API leak detection: ENABLED`);
  log.info(`Dry run: ${config.content.dryRun}`);

  // ── Verificar que Railway sync está configurado ───────────────────────
  const hasRailwaySync = !!process.env.RAILWAY_API_TOKEN;
  log.info(`Railway token sync: ${hasRailwaySync ? '✅ ENABLED' : '⚠️  DISABLED — tokens no sobreviven redeploys!'}`);
  if (!hasRailwaySync && process.env.RAILWAY_ENVIRONMENT) {
    log.error('🚨 ESTÁS EN RAILWAY SIN RAILWAY_API_TOKEN — los tokens se van a perder en cada redeploy!');
    log.error('🚨 Creá un token en https://railway.com/account/tokens y agregalo como RAILWAY_API_TOKEN');
  }

  log.info('═'.repeat(60));

  // ── Refresh inicial de tokens al arrancar ─────────────────────────────
  try {
    log.info('🔑 Refresh inicial de tokens al arrancar...');
    await forceRefresh();
    const health = await checkTokenHealth();
    log.info(`✅ Tokens OK. Access token expira en ${health.hoursUntilExpiry}h`);
  } catch (err) {
    log.error(`❌ Refresh inicial FALLÓ: ${err.message}`);
    log.error('El bot va a intentar refrescar en cada tweet slot, pero puede fallar.');
  }

  // ── Slots dinámicos del día ──────────────────────────────────────────────
  scheduleDaySlots();

  // ── Reset diario 00:05 ART (03:05 UTC) ──────────────────────────────────
  cron.schedule('5 3 * * *', async () => {
    log.info('\n🔄 Reset diario — recalculando horarios...');
    scheduleDaySlots();
  }, { scheduled: true, timezone: 'UTC' });

  // ── Thread semanal: Jueves 10:00 ART (13:00 UTC) ────────────────────────
  cron.schedule('0 13 * * 4', async () => {
    const label = '📝 Thread Semanal';
    if (running[label]) return;
    running[label] = true;
    log.info(`\n${'═'.repeat(60)}\nTHREAD SLOT | ${new Date().toISOString()}\n${'═'.repeat(60)}`);
    try {
      await monitored('Scheduler:Thread', async () => {
        await runPipeline({ dryRun: config.content.dryRun, forceRun: true, skipPosting: false, tweetType: null });
      }, { slot: label });
    } catch (err) { log.error(`Thread error: ${err.message}`); }
    running[label] = false;
  }, { scheduled: true, timezone: 'UTC' });
  log.info('  📝 Thread: Jueves 10:00 ART');

  // ── Health check diario 23:00 ART (02:00 UTC) ──────────────────────────
  cron.schedule('0 2 * * *', async () => {
    log.info('\n📊 Daily health check...');
    try {
      await monitored('HealthCheck', () => runDailyHealthCheck(), {});
    } catch (err) { log.error(`Health check error: ${err.message}`); }
  }, { scheduled: true, timezone: 'UTC' });
  log.info('  💊 Health check: 23:00 ART');

  // ── Limpieza semanal domingos 03:00 UTC ──────────────────────────────────
  cron.schedule('0 3 * * 0', async () => {
    try {
      const { cleanupOldFiles } = require('../src/storage/dataStore');
      log.info('Ejecutando limpieza semanal...');
      await cleanupOldFiles(30);
    } catch (e) { log.warn(`Cleanup error: ${e.message}`); }

    try {
      const { cleanup } = require('../src/storage/twitterDB');
      cleanup(14, 90);
    } catch (e) { /* optional */ }
  }, { scheduled: true, timezone: 'UTC' });

  // ── FASE 4: Twitter API daily usage summary at 23:55 ART (02:55 UTC) ───
  cron.schedule('55 2 * * *', () => {
    log.info('\n📊 Generating Twitter API daily usage summary...');
    try {
      const summary = generateDailySummary();
      log.info(`Twitter API usage: reads_attempted=${summary.total_reads_attempted} blocked=${summary.total_reads_blocked} executed=${summary.total_reads_executed} writes=${summary.total_writes}`);
    } catch (err) { log.warn(`Daily summary error: ${err.message}`); }
  }, { scheduled: true, timezone: 'UTC' });
  log.info('  📊 Twitter usage summary: 23:55 ART');

  // ── Performance Engine: 1×/día at 22:00 UTC (19:00 ART) ────────────────
  cron.schedule('0 22 * * *', async () => {
    log.info('\n📈 Performance Engine...');
    try {
      await monitored('PerformanceEngine', () => runPerformanceEngine(), {}, false);
    } catch (err) { log.warn(`Performance engine: ${err.message}`); }
  }, { scheduled: true, timezone: 'UTC' });

  // ── PROACTIVE TOKEN REFRESH: cada 90 minutos ─────────────────────────────
  // Twitter OAuth2 access tokens expiran en 2h. Refresh tokens son ROTATIVOS
  // (cada refresh invalida el anterior). Si no sincronizamos con Railway,
  // un redeploy usa tokens viejos → falla → requiere re-auth manual.
  // Este cron refresca proactivamente para mantener tokens siempre frescos
  // y sincronizados con Railway env vars.
  cron.schedule('*/90 * * * *', async () => {
    log.info('\n🔑 Proactive token refresh...');
    try {
      await forceRefresh();
      const health = await checkTokenHealth();
      log.info(`✅ Token refresh OK. Expira en ${health.hoursUntilExpiry}h`);
    } catch (err) {
      log.error(`❌ Proactive token refresh FAILED: ${err.message}`);
      // El tokenManager ya envía alerta por email si falla
    }
  }, { scheduled: true, timezone: 'UTC' });
  log.info('  🔑 Token refresh proactivo: cada 90 min');

  // ── Prompt Optimizer: semanal, domingos 04:00 UTC ────────────────────────
  cron.schedule('0 4 * * 0', async () => {
    log.info('\n🧠 Prompt Optimizer...');
    try {
      await monitored('PromptOptimizer', () => runPromptOptimizer(), {}, false);
    } catch (err) { log.warn(`Prompt optimizer: ${err.message}`); }
  }, { scheduled: true, timezone: 'UTC' });

  // ── --run-now testing flag ──────────────────────────────────────────────
  if (process.argv.includes('--run-now')) {
    const first = TWEET_WINDOWS[0];
    log.info(`--run-now: ejecutando ${first.label} en 3s...`);
    setTimeout(() => executeTweetSlot(first.label, first.type), 3000);
  }

  log.info('─'.repeat(60));
  log.info('Sistema corriendo. Esperando próximos slots...');
  log.info('═'.repeat(60));
}

// ─── Señales ────────────────────────────────────────────────────────────────

process.on('SIGTERM', () => { log.info('SIGTERM. Cerrando...'); clearActiveTimers(); process.exit(0); });
process.on('SIGINT',  () => { log.info('SIGINT. Cerrando...');  clearActiveTimers(); process.exit(0); });

start().catch(err => {
  log.error(`Fatal error en start(): ${err.message}`);
  process.exit(1);
});
