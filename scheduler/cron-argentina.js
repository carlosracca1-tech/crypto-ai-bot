'use strict';

/**
 * Scheduler con timing dinámico — Argentina (UTC-3)
 *
 * TWEETS: 6 por día en ventanas de tiempo aleatorias
 * ENGAGEMENT: 2 sesiones de replies por día en ventanas aleatorias
 *
 * Cada día a las 00:05 ART se recalculan los horarios del día siguiente.
 * Al arrancar, se calculan los horarios del día actual y se skippean
 * los slots que ya pasaron.
 *
 * Los horarios del día se guardan en data/daily_schedule.json para
 * poder inspeccionarlos desde los logs de Railway.
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const { createModuleLogger } = require('../src/utils/logger');
const { runPipeline }   = require('../src/pipeline');
const { runEngagement } = require('../src/engagement/engagementManager');
const { config }        = require('../src/config');

const log = createModuleLogger('Scheduler-AR');

// ─── Ventanas de tiempo para tweets (hora local Argentina) ──────────────────────
//
// Cada ventana tiene: [horaInicio, minInicio] → [horaFin, minFin]
// El scheduler elige un momento aleatorio dentro de cada ventana.
//
// 6 tweets/día = 2 ciclos de los 3 tipos (market / technical / narrative)
//
const TWEET_WINDOWS = [
  { startH: 8,  startM: 0,  endH: 9,  endM: 30, type: 'market_insight',    label: '📊 Market Insight'     },
  { startH: 10, startM: 30, endH: 12, endM: 0,  type: 'technical_analysis', label: '📈 Technical Analysis' },
  { startH: 13, startM: 30, endH: 15, endM: 0,  type: 'narrative_insight',  label: '🧠 Narrative Insight'  },
  { startH: 16, startM: 30, endH: 18, endM: 0,  type: 'market_insight',    label: '📊 Market Insight'     },
  { startH: 19, startM: 0,  endH: 20, endM: 30, type: 'technical_analysis', label: '📈 Technical Analysis' },
  { startH: 21, startM: 0,  endH: 22, endM: 30, type: 'narrative_insight',  label: '🧠 Narrative Insight'  },
];

// ─── Ventanas para engagement (replies) ────────────────────────────────────────

const ENGAGEMENT_WINDOWS = [
  { startH: 9,  startM: 45, endH: 10, endM: 45, label: '💬 Engagement AM' },
  { startH: 17, startM: 0,  endH: 18, endM: 30, label: '💬 Engagement PM' },
];

// ─── Constantes ────────────────────────────────────────────────────────────────

const ART_OFFSET_HOURS = -3; // UTC-3
const SCHEDULE_FILE    = path.join(process.cwd(), 'data', 'daily_schedule.json');

// Timers activos del día (para poder cancelarlos si hay reset)
const activeTimers = [];

// ─── Helpers de tiempo ─────────────────────────────────────────────────────────

/**
 * Dado un timestamp UTC, devuelve { year, month, day, hours, minutes, seconds }
 * en hora Argentina (UTC-3).
 */
function utcToART(ts = Date.now()) {
  const d = new Date(ts + ART_OFFSET_HOURS * 3600 * 1000);
  return {
    year:    d.getUTCFullYear(),
    month:   d.getUTCMonth(),
    day:     d.getUTCDate(),
    hours:   d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
  };
}

/**
 * Convierte hora ART (horas, minutos) de HOY a timestamp UTC.
 * Si la fecha ART es "hoy", usa la fecha actual en ART.
 */
function artTimeToUTC(hours, minutes) {
  const now   = new Date();
  const artNow = utcToART(now.getTime());
  // Construir fecha en ART como si fuera UTC, luego ajustar offset
  const artDate = Date.UTC(artNow.year, artNow.month, artNow.day, hours, minutes, 0);
  return artDate - ART_OFFSET_HOURS * 3600 * 1000; // ART → UTC
}

/**
 * Genera un entero aleatorio en [min, max] (inclusivo).
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Elige un momento aleatorio dentro de una ventana [startH:startM, endH:endM].
 * Devuelve { hours, minutes } en hora ART.
 */
function randomTimeInWindow(startH, startM, endH, endM) {
  const startTotal = startH * 60 + startM;
  const endTotal   = endH   * 60 + endM;
  const chosen     = randInt(startTotal, endTotal);
  return { hours: Math.floor(chosen / 60), minutes: chosen % 60 };
}

/**
 * Formatea hora como "HH:MM" (zero-padded).
 */
function fmt(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ─── Cálculo y scheduling del día ─────────────────────────────────────────────

function clearActiveTimers() {
  for (const t of activeTimers) clearTimeout(t);
  activeTimers.length = 0;
}

/**
 * Calcula los horarios aleatorios del día, los loggea y programa los timeouts.
 * Slots cuya hora ya pasó son skipped automáticamente.
 */
function scheduleDaySlots() {
  clearActiveTimers();

  const now     = Date.now();
  const artNow  = utcToART(now);
  const dayLabel = `${artNow.day}/${artNow.month + 1}/${artNow.year}`;

  log.info('═'.repeat(60));
  log.info(`NUEVO DÍA — Calculando horarios para ${dayLabel} (ART)`);
  log.info('─'.repeat(60));

  const schedule = { date: dayLabel, generatedAt: new Date().toISOString(), slots: [] };

  // ── Tweets ─────────────────────────────────────────────────────────────────
  for (const win of TWEET_WINDOWS) {
    const { hours, minutes } = randomTimeInWindow(win.startH, win.startM, win.endH, win.endM);
    const fireUTC  = artTimeToUTC(hours, minutes);
    const delayMs  = fireUTC - now;

    const slotInfo = {
      label:    win.label,
      type:     'tweet',
      tweetType: win.type,
      timeART:  fmt(hours, minutes),
      status:   delayMs > 0 ? 'scheduled' : 'skipped (past)',
    };
    schedule.slots.push(slotInfo);

    if (delayMs <= 0) {
      log.info(`  ⏭  SKIP (pasó)   ${win.label.padEnd(22)} ${fmt(hours, minutes)} ART`);
      continue;
    }

    log.info(`  ✓  AGENDADO      ${win.label.padEnd(22)} ${fmt(hours, minutes)} ART  (+${Math.round(delayMs / 60000)} min)`);

    const timer = setTimeout(() => executeTweetSlot(win.label, win.type), delayMs);
    activeTimers.push(timer);
  }

  log.info('─'.repeat(60));

  // ── Engagement ─────────────────────────────────────────────────────────────
  for (const win of ENGAGEMENT_WINDOWS) {
    const { hours, minutes } = randomTimeInWindow(win.startH, win.startM, win.endH, win.endM);
    const fireUTC  = artTimeToUTC(hours, minutes);
    const delayMs  = fireUTC - now;

    const slotInfo = {
      label:   win.label,
      type:    'engagement',
      timeART: fmt(hours, minutes),
      status:  delayMs > 0 ? 'scheduled' : 'skipped (past)',
    };
    schedule.slots.push(slotInfo);

    if (delayMs <= 0) {
      log.info(`  ⏭  SKIP (pasó)   ${win.label.padEnd(22)} ${fmt(hours, minutes)} ART`);
      continue;
    }

    log.info(`  ✓  AGENDADO      ${win.label.padEnd(22)} ${fmt(hours, minutes)} ART  (+${Math.round(delayMs / 60000)} min)`);

    const timer = setTimeout(() => executeEngagementSlot(win.label), delayMs);
    activeTimers.push(timer);
  }

  log.info('─'.repeat(60));
  log.info(`Total timers activos: ${activeTimers.length}`);
  log.info('═'.repeat(60));

  // Persistir schedule del día
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
  } catch (e) {
    log.warn(`No se pudo guardar schedule: ${e.message}`);
  }
}

// ─── Ejecutores ────────────────────────────────────────────────────────────────

const running = {};

async function executeTweetSlot(label, tweetType) {
  const key = `tweet_${tweetType}_${Date.now()}`;
  if (running[label]) {
    log.warn(`${label} ya está corriendo — skip`);
    return;
  }

  running[label] = true;
  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  log.info(`\n${'═'.repeat(60)}`);
  log.info(`TWEET SLOT: ${label} | Hora AR: ${now}`);
  log.info(`${'═'.repeat(60)}`);

  try {
    const result = await runPipeline({
      dryRun:      config.content.dryRun,
      forceRun:    true,
      skipPosting: false,
      tweetType,
    });

    if (result) {
      const posted = result.publishResults?.filter(r => r.success !== false).length || 0;
      log.info(`✓ ${label} completado | Publicados: ${posted} | Duración: ${result.runSummary?.duration || '?'}`);
    }
  } catch (err) {
    log.error(`✗ Error en ${label}: ${err.message}`);
    log.error(err.stack);
  } finally {
    running[label] = false;
  }
}

async function executeEngagementSlot(label) {
  if (running[label]) {
    log.warn(`${label} ya está corriendo — skip`);
    return;
  }

  running[label] = true;
  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  log.info(`\n${'═'.repeat(60)}`);
  log.info(`ENGAGEMENT SLOT: ${label} | Hora AR: ${now}`);
  log.info(`${'═'.repeat(60)}`);

  try {
    const result = await runEngagement({ dryRun: config.content.dryRun });
    log.info(`✓ ${label} completado | Replies: ${result.posted || 0} | Skipped: ${result.skipped || 0}`);
  } catch (err) {
    log.error(`✗ Error en ${label}: ${err.message}`);
    log.error(err.stack);
  } finally {
    running[label] = false;
  }
}

// ─── Reset diario a medianoche ART ────────────────────────────────────────────

function start() {
  log.info('═'.repeat(60));
  log.info('AI CRYPTO BOT — SCHEDULER DINÁMICO ACTIVO');
  log.info(`Dry run: ${config.content.dryRun}`);
  log.info(`Tweets/día: ${TWEET_WINDOWS.length} | Engagement sessions/día: ${ENGAGEMENT_WINDOWS.length}`);
  log.info('═'.repeat(60));

  // Programar slots del día actual al arrancar
  scheduleDaySlots();

  // Reset diario: 00:05 ART = 03:05 UTC
  cron.schedule('5 3 * * *', () => {
    log.info('\n🔄 Reset diario — recalculando horarios del nuevo día...');
    scheduleDaySlots();
  }, { scheduled: true, timezone: 'UTC' });

  // Limpieza semanal: domingos 02:00 UTC
  cron.schedule('0 2 * * 0', async () => {
    const { cleanupOldFiles } = require('../src/storage/dataStore');
    log.info('Ejecutando limpieza semanal...');
    await cleanupOldFiles(30);
  }, { scheduled: true, timezone: 'UTC' });

  // --run-now: fuerza un tweet inmediatamente (testing)
  if (process.argv.includes('--run-now')) {
    const first = TWEET_WINDOWS[0];
    log.info(`--run-now detectado. Ejecutando ${first.label} en 3 segundos...`);
    setTimeout(() => executeTweetSlot(first.label, first.type), 3000);
  }
}

// ─── Señales del proceso ───────────────────────────────────────────────────────

process.on('SIGTERM', () => { log.info('SIGTERM. Cerrando...'); clearActiveTimers(); process.exit(0); });
process.on('SIGINT',  () => { log.info('SIGINT. Cerrando...');  clearActiveTimers(); process.exit(0); });

process.on('uncaughtException', (err) => {
  log.error(`Excepción no capturada: ${err.message}`);
  log.error(err.stack);
  // No matar el proceso — el scheduler debe ser resiliente
});

process.on('unhandledRejection', (reason) => {
  log.error(`Promise rechazada: ${reason}`);
});

// ─── Start ─────────────────────────────────────────────────────────────────────

start();
