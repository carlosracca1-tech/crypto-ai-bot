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
// Errores que NO deben reintentarse (no son transitorios)
const NON_RETRYABLE_CODES = ['402', '401', '403'];

function isNonRetryableError(err) {
  const msg = err.message || '';
  const code = String(err.code || err.statusCode || err.response?.status || '');
  return NON_RETRYABLE_CODES.some(c => msg.includes(c) || code === c);
}

function isRateLimitError(err) {
  const msg = err.message || '';
  const code = String(err.code || err.statusCode || err.response?.status || '');
  return msg.includes('429') || code === '429';
}

async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 2000,
    backoffMultiplier = 2,
    label = 'operation',
    rateLimitCooldownMs = 15000,
  } = opts;

  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // No reintentar errores de billing/auth (402, 401, 403)
      if (isNonRetryableError(err)) {
        log.error(`${label} falló con error no-reintentable: ${err.message}`);
        throw err;
      }

      const isLast = attempt > maxRetries;

      if (isLast) {
        log.error(`${label} falló después de ${maxRetries} reintentos`, { error: err.message });
        throw err;
      }

      // Rate limit (429): usar cooldown más largo para esperar el reset window
      if (isRateLimitError(err)) {
        const cooldown = rateLimitCooldownMs * attempt;
        log.warn(`${label} hit rate limit (429) en intento ${attempt}/${maxRetries}. Cooldown ${cooldown}ms`, {
          error: err.message,
        });
        await sleep(cooldown);
      } else {
        const delay = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);
        log.warn(`${label} falló en intento ${attempt}/${maxRetries}. Reintentando en ${delay}ms`, {
          error: err.message,
        });
        await sleep(delay);
      }
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
