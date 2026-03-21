'use strict';

const { createModuleLogger } = require('./logger');
const log = createModuleLogger('Retry');

/**
 * Ejecuta una función asíncrona con reintentos exponenciales
 * @param {Function} fn - Función a ejecutar
 * @param {object} opts - Opciones
 * @param {number} opts.maxRetries - Máximo de reintentos
 * @param {number} opts.baseDelayMs - Delay base en ms
 * @param {number} opts.backoffMultiplier - Multiplicador exponencial
 * @param {string} opts.label - Etiqueta para el log
 * @returns {Promise<any>}
 */
async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 2000,
    backoffMultiplier = 2,
    label = 'operation',
  } = opts;

  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLast = attempt > maxRetries;

      if (isLast) {
        log.error(`${label} falló después de ${maxRetries} reintentos`, { error: err.message });
        throw err;
      }

      const delay = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);
      log.warn(`${label} falló en intento ${attempt}/${maxRetries}. Reintentando en ${delay}ms`, {
        error: err.message,
      });
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Delay simple
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ejecuta operaciones con límite de concurrencia
 * @param {Array<Function>} tasks - Array de funciones async
 * @param {number} concurrency - Límite de concurrencia
 */
async function runWithConcurrency(tasks, concurrency = 3) {
  const results = [];
  const queue = [...tasks];

  async function runNext() {
    if (queue.length === 0) return;
    const task = queue.shift();
    const result = await task();
    results.push(result);
    await runNext();
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, runNext);
  await Promise.all(workers);
  return results;
}

module.exports = { withRetry, sleep, runWithConcurrency };
