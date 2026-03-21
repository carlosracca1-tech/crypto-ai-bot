'use strict';

require('dotenv').config();

const cron = require('node-cron');
const { createModuleLogger } = require('../src/utils/logger');
const { runPipeline } = require('../src/pipeline');
const { config } = require('../src/config');

const log = createModuleLogger('Scheduler');

// ─── Configuración de horarios ─────────────────────────────────────────────────
// El pipeline principal corre una vez al día a las 06:00 UTC
// Los tweets se espacian internamente durante el día

const MAIN_PIPELINE_CRON = process.env.CRON_SCHEDULE || '0 6 * * *';
// '0 6 * * *' = 06:00 UTC cada día
// '0 */4 * * *' = cada 4 horas (para desarrollo)

let isRunning = false;

// ─── Job principal ─────────────────────────────────────────────────────────────

async function executeScheduledRun() {
  if (isRunning) {
    log.warn('Pipeline ya en ejecución, saltando esta invocación');
    return;
  }

  isRunning = true;
  log.info(`Ejecución programada iniciada (${new Date().toISOString()})`);

  try {
    const result = await runPipeline({
      dryRun: config.content.dryRun,
      forceRun: false,
      skipPosting: false,
    });

    if (result) {
      log.info(`Ejecución completada en ${result.runSummary.duration}`);
    }
  } catch (err) {
    log.error(`Error en ejecución programada: ${err.message}`);
    log.error(err.stack);
  } finally {
    isRunning = false;
  }
}

// ─── Validar expresión cron ────────────────────────────────────────────────────

function validateAndStart() {
  if (!cron.validate(MAIN_PIPELINE_CRON)) {
    log.error(`Expresión cron inválida: ${MAIN_PIPELINE_CRON}`);
    process.exit(1);
  }

  log.info('═══════════════════════════════════════════════════════════');
  log.info('AI CRYPTO BOT - SCHEDULER INICIADO');
  log.info(`Schedule: ${MAIN_PIPELINE_CRON}`);
  log.info(`Dry run: ${config.content.dryRun}`);
  log.info(`Tweets per day: ${config.content.tweetsPerDay}`);
  log.info(`Thread every: ${config.content.threadEveryNDays} days`);
  log.info('═══════════════════════════════════════════════════════════');

  // Job principal
  const mainJob = cron.schedule(MAIN_PIPELINE_CRON, executeScheduledRun, {
    scheduled: true,
    timezone: 'UTC',
  });

  // Job de limpieza semanal (domingos a las 00:00 UTC)
  const cleanupJob = cron.schedule('0 0 * * 0', async () => {
    const { cleanupOldFiles } = require('../src/storage/dataStore');
    log.info('Ejecutando limpieza semanal...');
    await cleanupOldFiles(30);
  }, { scheduled: true, timezone: 'UTC' });

  log.info('Jobs programados activos. Esperando próxima ejecución...');

  // Próxima ejecución estimada
  const nextRun = getNextCronRun(MAIN_PIPELINE_CRON);
  if (nextRun) {
    const msUntilNext = nextRun - Date.now();
    const hoursUntilNext = (msUntilNext / 1000 / 60 / 60).toFixed(1);
    log.info(`Próxima ejecución en ~${hoursUntilNext} horas (${nextRun.toISOString()})`);
  }

  // Ejecutar inmediatamente si se pasa --run-now
  if (process.argv.includes('--run-now')) {
    log.info('--run-now detectado. Ejecutando pipeline inmediatamente...');
    setTimeout(executeScheduledRun, 2000);
  }

  return { mainJob, cleanupJob };
}

/**
 * Estimación simple de la próxima ejecución del cron
 */
function getNextCronRun(cronExpr) {
  try {
    // Esta es una estimación simplificada
    // Para producción usar 'cron-parser'
    const parts = cronExpr.split(' ');
    const hour = parseInt(parts[1]);
    const next = new Date();
    next.setUTCHours(hour, 0, 0, 0);
    if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  } catch {
    return null;
  }
}

// ─── Manejo de señales del sistema ─────────────────────────────────────────────

process.on('SIGTERM', () => {
  log.info('SIGTERM recibido. Cerrando scheduler...');
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('SIGINT recibido. Cerrando scheduler...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log.error(`Excepción no capturada: ${err.message}`);
  log.error(err.stack);
  // No matar el proceso - el scheduler debe ser resistente
});

process.on('unhandledRejection', (reason) => {
  log.error(`Promise rechazada sin manejar: ${reason}`);
});

// ─── Start ─────────────────────────────────────────────────────────────────────

validateAndStart();
