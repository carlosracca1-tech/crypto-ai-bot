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
const TWEET_WINDOWS = [
  { startH: 8,  startM: 0,  endH: 9,  endM: 30, type: 'market_insight',      label: '📊 Market Insight'      },
  { startH: 10, startM: 30, endH: 12, endM: 0,  type: 'fundamental_insight', label: '🔬 Fundamental Insight'  },
  { startH: 13, startM: 30, endH: 15, endM: 0,  type: 'technical_analysis',  label: '📈 Technical Analysis'   },
  { startH: 16, startM: 30, endH: 18, endM: 0,  type: 'contrarian',          label: '⚡ Contrarian Take'      },
  { startH: 19, startM: 0,  endH: 20, endM: 30, type: 'narrative_insight',   label: '🧠 Narrative Insight'    },
  { startH: 21, startM: 0,  endH: 22, endM: 30, type: 'market_insight',      label: '📊 Market Insight (Eve)' },
];

// ─── ENGAGEMENT WINDOWS (ART) ─────────────────────────────────────────────────

const ENGAGEMENT_WINDOWS = [
  { startH: 9,  startM: 45, endH: 10, endM: 45, label: '💬 Engagement AM' },
  { startH: 17, startM: 0,  endH: 18, endM: 30, label: '💬 Engagement PM' },
];

// ─── FOLLOW WINDOW (ART) ──────────────────────────────────────────────────────

const FOLLOW_WINDOW = { startH: 12, startM: 0, endH: 13, endM: 30, label: '🔍 Follow Session' };

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

  // ── Engagement slots ────────────────────────────────────────────────────────
  for (const win of ENGAGEMENT_WINDOWS) {
    const { hours, minutes } = randomTimeInWindow(win.startH, win.startM, win.endH, win.endM);
    const fireUTC = artTimeToUTC(hours, minutes);
    const delayMs = fireUTC - now;

    schedule.slots.push({ label: win.label, type: 'engagement', timeART: fmt(hours, minutes), status: delayMs > 0 ? 'scheduled' : 'past' });

    if (delayMs <= 0) {
      log.info(`  ⏭  SKIP  ${win.label.padEnd(24)} ${fmt(hours, minutes)} ART`);
      continue;
    }
    log.info(`  ✓  ${win.label.padEnd(24)} ${fmt(hours, minutes)} ART  (+${Math.round(delayMs / 60000)} min)`);
    activeTimers.push(setTimeout(() => executeEngagementSlot(win.label), delayMs));
  }

  // ── Follow slot ─────────────────────────────────────────────────────────────
  {
    const { hours, minutes } = randomTimeInWindow(FOLLOW_WINDOW.startH, FOLLOW_WINDOW.startM, FOLLOW_WINDOW.endH, FOLLOW_WINDOW.endM);
    const fireUTC = artTimeToUTC(hours, minutes);
    const delayMs = fireUTC - now;

    schedule.slots.push({ label: FOLLOW_WINDOW.label, type: 'follow', timeART: fmt(hours, minutes), status: delayMs > 0 ? 'scheduled' : 'past' });

    if (delayMs > 0) {
      log.info(`  ✓  ${FOLLOW_WINDOW.label.padEnd(24)} ${fmt(hours, minutes)} ART  (+${Math.round(delayMs / 60000)} min)`);
      activeTimers.push(setTimeout(() => executeFollowSlot(), delayMs));
    } else {
      log.info(`  ⏭  SKIP  ${FOLLOW_WINDOW.label.padEnd(24)} ${fmt(hours, minutes)} ART`);
    }
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
  if (running[label]) { log.warn(`${label} ya corre — skip`); return; }
  running[label] = true;

  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  log.info(`\n${'═'.repeat(60)}\nENGAGEMENT: ${label} | ${now}\n${'═'.repeat(60)}`);

  await monitored(`Scheduler:${label}`, async () => {
    const result = await runEngagement({ dryRun: config.content.dryRun });
    log.info(`✓ ${label} | Replies: ${result.posted || 0} | Skipped: ${result.skipped || 0}`);
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

  log.info('═'.repeat(60));
  log.info('AI CRYPTO BOT — SISTEMA UNIFICADO ACTIVO');
  log.info(`Dry run: ${config.content.dryRun}`);
  log.info(`Tweets/día: ${TWEET_WINDOWS.length} | Engagement: ${ENGAGEMENT_WINDOWS.length} sesiones | 1 follow session`);
  log.info('═'.repeat(60));

  // ── Slots dinámicos del día ─────────────────────────────────────────────────
  scheduleDaySlots();

  // ── Reset diario 00:05 ART (03:05 UTC) ─────────────────────────────────────
  cron.schedule('5 3 * * *', () => {
    log.info('\n🔄 Reset diario — recalculando horarios...');
    scheduleDaySlots();
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
  }, { scheduled: true, timezone: 'UTC' });

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
