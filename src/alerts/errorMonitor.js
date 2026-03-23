'use strict';

/**
 * Error Monitor
 *
 * Captura errores de cualquier función async, los loggea y dispara
 * una alerta de email inmediata. Diseñado para envolver las llamadas
 * clave del pipeline y el scheduler sin romper el flujo normal.
 */

const { createModuleLogger } = require('../utils/logger');
const { sendErrorAlert }     = require('./emailAlerts');

const log = createModuleLogger('ErrorMonitor');

// ─── In-process error counter (reset al reiniciar) ─────────────────────────────

let errorCount = 0;
const recentErrors = []; // últimos 50 errores con timestamp

function recordError(module, message, stack) {
  errorCount++;
  recentErrors.unshift({ module, message, stack: stack?.split('\n').slice(0, 5).join('\n'), ts: new Date().toISOString() });
  if (recentErrors.length > 50) recentErrors.pop();
}

// ─── Wrapper principal ─────────────────────────────────────────────────────────

/**
 * Envuelve una función async con captura de errores + alerta de email.
 *
 * @param {string}   moduleName  - Nombre del módulo para el email
 * @param {Function} fn          - Función async a ejecutar
 * @param {object}   [context]   - Contexto adicional para el email (ej. { tweetType: 'market_insight' })
 * @param {boolean}  [rethrow]   - Si true, relanza el error después de alertar (default: false)
 * @returns {Promise<any>}       - Resultado de fn, o null si falla
 */
async function monitored(moduleName, fn, context = {}, rethrow = false) {
  try {
    return await fn();
  } catch (err) {
    const msg   = err?.message || String(err);
    const stack = err?.stack   || String(err);

    log.error(`[${moduleName}] ${msg}`);
    recordError(moduleName, msg, stack);

    // Disparar alerta async (no bloquea el scheduler)
    setImmediate(async () => {
      try {
        await sendErrorAlert({ module: moduleName, error: msg, stack, context });
      } catch (emailErr) {
        log.error(`No se pudo enviar alerta de email: ${emailErr.message}`);
      }
    });

    if (rethrow) throw err;
    return null;
  }
}

// ─── Error stats públicas (para health check) ─────────────────────────────────

function getErrorStats() {
  return {
    totalErrors: errorCount,
    recentErrors: [...recentErrors],
  };
}

function resetErrorCount() {
  errorCount = 0;
  recentErrors.length = 0;
}

// ─── Global uncaught exception handler ────────────────────────────────────────

/**
 * Instala handlers globales para capturar errores no capturados.
 * Llama a esto desde scheduler/cron-argentina.js al arrancar.
 */
function installGlobalHandlers() {
  process.on('uncaughtException', (err) => {
    log.error(`UNCAUGHT EXCEPTION: ${err.message}`);
    recordError('uncaughtException', err.message, err.stack);
    setImmediate(async () => {
      try {
        await sendErrorAlert({
          module: 'Process (uncaughtException)',
          error:  err.message,
          stack:  err.stack,
          context: { pid: process.pid, uptime: `${Math.round(process.uptime())}s` },
        });
      } catch (e) { log.error(`Email alert failed: ${e.message}`); }
    });
    // No matar el proceso — el scheduler debe ser resiliente
  });

  process.on('unhandledRejection', (reason) => {
    const msg   = reason?.message || String(reason);
    const stack = reason?.stack   || String(reason);
    log.error(`UNHANDLED REJECTION: ${msg}`);
    recordError('unhandledRejection', msg, stack);
    setImmediate(async () => {
      try {
        await sendErrorAlert({
          module: 'Process (unhandledRejection)',
          error:  msg,
          stack,
          context: { pid: process.pid },
        });
      } catch (e) { log.error(`Email alert failed: ${e.message}`); }
    });
  });

  log.info('Global error handlers installed');
}

module.exports = { monitored, getErrorStats, resetErrorCount, installGlobalHandlers };
