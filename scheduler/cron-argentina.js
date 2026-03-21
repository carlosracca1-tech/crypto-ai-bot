'use strict';

require('dotenv').config();

const cron = require('node-cron');
const { createModuleLogger } = require('../src/utils/logger');
const { runPipeline } = require('../src/pipeline');
const { config } = require('../src/config');

const log = createModuleLogger('Scheduler-AR');

// ─── Horarios Argentina (UTC-3) convertidos a UTC ──────────────────────────────
//
//   9:30 ART  →  12:30 UTC  →  '30 12 * * *'  →  market_insight
//  13:30 ART  →  16:30 UTC  →  '30 16 * * *'  →  technical_analysis
//  19:30 ART  →  22:30 UTC  →  '30 22 * * *'  →  narrative_insight
//
// NOTA: Si en verano el offset cambia, ajustar restando 3 horas siempre.

const SCHEDULE = [
  {
    name:      'Mañana (9:30 ART)',
    cron:      '30 12 * * *',
    tweetType: 'market_insight',
    label:     '📊 Market Insight',
  },
  {
    name:      'Mediodía (13:30 ART)',
    cron:      '30 16 * * *',
    tweetType: 'technical_analysis',
    label:     '📈 Technical Analysis',
  },
  {
    name:      'Noche (19:30 ART)',
    cron:      '30 22 * * *',
    tweetType: 'narrative_insight',
    label:     '🧠 Narrative Insight',
  },
];

// Llevar registro de cuáles están corriendo para no lanzar dos a la vez
const running = {};

// ─── Ejecutor de slot ──────────────────────────────────────────────────────────

async function executeSlot(slot) {
  if (running[slot.name]) {
    log.warn(`${slot.name} ya está en ejecución, saltando...`);
    return;
  }

  running[slot.name] = true;
  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  log.info(`\n${'═'.repeat(60)}`);
  log.info(`SLOT: ${slot.label} | Hora AR: ${now}`);
  log.info(`${'═'.repeat(60)}`);

  try {
    const result = await runPipeline({
      dryRun:     config.content.dryRun,
      forceRun:   true,      // permite correr múltiples veces por día
      skipPosting: false,
      tweetType:  slot.tweetType,
    });

    if (result) {
      const posted = result.publishResults?.filter(r => r.success !== false).length || 0;
      log.info(`✓ ${slot.label} completado | Publicados: ${posted} | Duración: ${result.runSummary.duration}`);
    }
  } catch (err) {
    log.error(`✗ Error en ${slot.name}: ${err.message}`);
    log.error(err.stack);
  } finally {
    running[slot.name] = false;
  }
}

// ─── Inicio ────────────────────────────────────────────────────────────────────

function start() {
  log.info('═'.repeat(60));
  log.info('AI CRYPTO BOT — SCHEDULER ARGENTINA ACTIVO');
  log.info(`Dry run: ${config.content.dryRun}`);
  log.info('─'.repeat(60));

  for (const slot of SCHEDULE) {
    if (!cron.validate(slot.cron)) {
      log.error(`Expresión cron inválida para ${slot.name}: ${slot.cron}`);
      process.exit(1);
    }

    cron.schedule(slot.cron, () => executeSlot(slot), {
      scheduled: true,
      timezone:  'UTC',
    });

    log.info(`  ${slot.label.padEnd(28)} → cron: ${slot.cron} UTC  (${slot.name})`);
  }

  log.info('─'.repeat(60));
  log.info('Scheduler corriendo. Esperando próximos slots...');
  log.info('═'.repeat(60));

  // Limpieza semanal (domingos 02:00 UTC)
  cron.schedule('0 2 * * 0', async () => {
    const { cleanupOldFiles } = require('../src/storage/dataStore');
    log.info('Ejecutando limpieza semanal...');
    await cleanupOldFiles(30);
  }, { scheduled: true, timezone: 'UTC' });

  // --run-now: ejecuta el primer slot inmediatamente (para testing)
  if (process.argv.includes('--run-now')) {
    const slot = SCHEDULE[0];
    log.info(`--run-now detectado. Ejecutando ${slot.name} en 3 segundos...`);
    setTimeout(() => executeSlot(slot), 3000);
  }
}

// ─── Manejo de señales ─────────────────────────────────────────────────────────

process.on('SIGTERM', () => { log.info('SIGTERM. Cerrando...'); process.exit(0); });
process.on('SIGINT',  () => { log.info('SIGINT. Cerrando...');  process.exit(0); });

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
