'use strict';

/**
 * twitterSafeClient.js — CAPA DE CONTROL CENTRALIZADA de Twitter API
 *
 * Intercepta TODAS las llamadas a Twitter API.
 * - READ + readsDisabled=true  → BLOQUEA + LOG + retorna fallback
 * - WRITE                      → PERMITE siempre
 *
 * USO: Reemplazar fetch() directo y TwitterApi calls por este wrapper.
 *
 * Esto elimina fugas futuras: cualquier módulo que use twitterSafeClient
 * tiene el control de reads automáticamente aplicado.
 */

const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('TwitterSafeClient');

// ─── Twitter API Usage Logger (FASE 3) ─────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(process.cwd(), 'data');
const USAGE_LOG = path.join(DATA_DIR, 'twitter_api_usage.jsonl');

/**
 * Log every Twitter API request (executed or blocked)
 */
function logApiUsage(entry) {
  const record = {
    timestamp: new Date().toISOString(),
    module:    entry.module    || 'unknown',
    function:  entry.function  || 'unknown',
    endpoint:  entry.endpoint  || 'unknown',
    method:    entry.method    || 'GET',
    type:      entry.type      || 'READ',   // READ | WRITE
    status:    entry.status    || 'executed', // executed | blocked
    ids_count: entry.ids_count || 0,
    response_time_ms: entry.response_time_ms || 0,
    error:     entry.error     || null,
  };

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(USAGE_LOG, JSON.stringify(record) + '\n');
  } catch (err) {
    log.warn(`Failed to write API usage log: ${err.message}`);
  }

  // Also log to winston for unified logging
  if (record.status === 'blocked') {
    log.info(`READ_BLOCKED_BY_CONFIG | ${record.module}.${record.function} → ${record.endpoint}`, {
      type: record.type,
      status: record.status,
      module: record.module,
    });
  } else {
    log.info(`API_CALL_${record.type} | ${record.module}.${record.function} → ${record.endpoint} (${record.response_time_ms}ms)`, {
      type: record.type,
      status: record.status,
    });
  }

  return record;
}

// ─── READ endpoint patterns ─────────────────────────────────────────────────

const READ_ENDPOINTS = [
  /\/2\/tweets\?ids=/,       // GET tweets by ID (metrics)
  /\/2\/tweets\/search/,     // Search tweets
  /\/2\/search/,             // Search (alternative)
  /\/2\/users\/me/,          // Get authenticated user
  /\/2\/users\//,            // Any user lookup
  /\/1\.1\/search/,          // v1.1 search
  /\/1\.1\/statuses\/lookup/, // v1.1 tweet lookup
];

const WRITE_ENDPOINTS = [
  /POST.*\/2\/tweets$/,       // Post tweet
  /\/2\/users\/.*\/retweets/, // Retweet
  /\/2\/tweets\/.*\/reply/,   // Reply
  /\/2\/users\/.*\/likes/,    // Like
  /\/1\.1\/media/,            // Media upload
  /\/1\.1\/friendships/,      // Follow/Unfollow
  /oauth2\/token/,            // Token refresh (neither read nor write)
];

/**
 * Classify a Twitter API request as READ or WRITE
 */
function classifyRequest(url, method = 'GET') {
  const upperMethod = (method || 'GET').toUpperCase();

  // POST to /2/tweets (create tweet) = WRITE
  if (upperMethod === 'POST' && /\/2\/tweets$/.test(url)) return 'WRITE';
  // POST to any write endpoint = WRITE
  if (upperMethod === 'POST') {
    for (const pattern of WRITE_ENDPOINTS) {
      if (pattern.test(url) || pattern.test(`${upperMethod} ${url}`)) return 'WRITE';
    }
  }

  // Media upload = WRITE
  if (/media|upload/i.test(url) && upperMethod === 'POST') return 'WRITE';

  // Anything with GET to a read endpoint = READ
  for (const pattern of READ_ENDPOINTS) {
    if (pattern.test(url)) return 'READ';
  }

  // Default: GET = READ, POST = WRITE
  return upperMethod === 'GET' ? 'READ' : 'WRITE';
}

// ─── Safe fetch wrapper ─────────────────────────────────────────────────────

/**
 * Wraps fetch() for Twitter API calls.
 * Blocks READs when readsDisabled=true.
 *
 * @param {string} url        - Twitter API URL
 * @param {object} options    - fetch options
 * @param {object} meta       - { module, function, ids_count }
 * @returns {Promise<Response|object>}
 */
async function safeFetch(url, options = {}, meta = {}) {
  const method   = (options.method || 'GET').toUpperCase();
  const type     = classifyRequest(url, method);
  const module_  = meta.module   || 'unknown';
  const func     = meta.function || 'unknown';

  // ── BLOCK READ if readsDisabled ──────────────────────────────────────────
  if (type === 'READ' && config.twitter.readsDisabled) {
    logApiUsage({
      module:   module_,
      function: func,
      endpoint: url.replace(/https:\/\/api\.twitter\.com/, '').split('?')[0],
      method,
      type:     'READ',
      status:   'blocked',
      ids_count: meta.ids_count || 0,
    });

    // Return a mock Response-like object
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      text: async () => '{"data":[]}',
      _blocked: true,
    };
  }

  // ── EXECUTE (write or read when enabled) ──────────────────────────────────
  const start = Date.now();
  let error   = null;

  try {
    const response = await fetch(url, options);
    const elapsed  = Date.now() - start;

    logApiUsage({
      module:   module_,
      function: func,
      endpoint: url.replace(/https:\/\/api\.twitter\.com/, '').split('?')[0],
      method,
      type,
      status:   'executed',
      ids_count: meta.ids_count || 0,
      response_time_ms: elapsed,
    });

    return response;
  } catch (err) {
    error = err;
    logApiUsage({
      module:   module_,
      function: func,
      endpoint: url.replace(/https:\/\/api\.twitter\.com/, '').split('?')[0],
      method,
      type,
      status:   'executed',
      ids_count: meta.ids_count || 0,
      response_time_ms: Date.now() - start,
      error:    err.message,
    });
    throw err;
  }
}

// ─── Safe TwitterApi v2 wrapper ─────────────────────────────────────────────

/**
 * Wraps TwitterApi v2 search call.
 * Blocks when readsDisabled=true.
 *
 * @param {object} client      - TwitterApi instance
 * @param {string} query       - Search query
 * @param {object} params      - Search params
 * @param {object} meta        - { module, function }
 * @returns {Promise<object>}
 */
async function safeSearch(client, query, params = {}, meta = {}) {
  const module_ = meta.module   || 'unknown';
  const func    = meta.function || 'unknown';

  if (config.twitter.readsDisabled) {
    logApiUsage({
      module:   module_,
      function: func,
      endpoint: '/2/tweets/search/recent',
      method:   'GET',
      type:     'READ',
      status:   'blocked',
      ids_count: 0,
    });

    return { data: { data: [], includes: { users: [] } } };
  }

  const start = Date.now();
  try {
    const result = await client.v2.search(query, params);
    logApiUsage({
      module:   module_,
      function: func,
      endpoint: '/2/tweets/search/recent',
      method:   'GET',
      type:     'READ',
      status:   'executed',
      ids_count: result.data?.data?.length || 0,
      response_time_ms: Date.now() - start,
    });
    return result;
  } catch (err) {
    logApiUsage({
      module:   module_,
      function: func,
      endpoint: '/2/tweets/search/recent',
      method:   'GET',
      type:     'READ',
      status:   'executed',
      ids_count: 0,
      response_time_ms: Date.now() - start,
      error:    err.message,
    });
    throw err;
  }
}

/**
 * Wraps v2.me() call — a READ.
 */
async function safeGetMe(client, params = {}, meta = {}) {
  const module_ = meta.module   || 'unknown';
  const func    = meta.function || 'unknown';

  if (config.twitter.readsDisabled) {
    logApiUsage({
      module:   module_,
      function: func,
      endpoint: '/2/users/me',
      method:   'GET',
      type:     'READ',
      status:   'blocked',
    });
    return null; // caller must handle fallback
  }

  const start = Date.now();
  try {
    const result = await client.v2.me(params);
    logApiUsage({
      module:   module_,
      function: func,
      endpoint: '/2/users/me',
      method:   'GET',
      type:     'READ',
      status:   'executed',
      response_time_ms: Date.now() - start,
    });
    return result;
  } catch (err) {
    logApiUsage({
      module:   module_,
      function: func,
      endpoint: '/2/users/me',
      method:   'GET',
      type:     'READ',
      status:   'executed',
      response_time_ms: Date.now() - start,
      error:    err.message,
    });
    throw err;
  }
}

/**
 * Log a WRITE operation (for tracking only, never blocked)
 */
function logWrite(meta = {}) {
  logApiUsage({
    module:    meta.module   || 'unknown',
    function:  meta.function || 'unknown',
    endpoint:  meta.endpoint || '/2/tweets',
    method:    'POST',
    type:      'WRITE',
    status:    'executed',
    response_time_ms: meta.response_time_ms || 0,
    error:     meta.error || null,
  });
}

// ─── Leak detection (FASE 8) ────────────────────────────────────────────────

/**
 * Check if a raw fetch() to Twitter API is being made outside this wrapper.
 * Call this from a monkey-patched global fetch to detect leaks.
 */
let _leakDetectionEnabled = false;
const _originalFetch = globalThis.fetch;

function enableLeakDetection() {
  if (_leakDetectionEnabled) return;
  _leakDetectionEnabled = true;

  globalThis.fetch = function patchedFetch(url, ...args) {
    const urlStr = typeof url === 'string' ? url : url?.url || '';

    if (/api\.twitter\.com/.test(urlStr)) {
      const type = classifyRequest(urlStr, args[0]?.method || 'GET');

      if (type === 'READ' && config.twitter.readsDisabled) {
        const err = new Error('LEAK_DETECTED');
        const stack = err.stack || '';
        const callerLine = stack.split('\n')[2] || 'unknown';

        log.error(`🚨 TWITTER_READ_LEAK_DETECTED | Direct fetch() to Twitter READ API bypassing twitterSafeClient! | Caller: ${callerLine.trim()}`);

        logApiUsage({
          module:   'LEAK_DETECTOR',
          function: 'patchedFetch',
          endpoint: urlStr.replace(/https:\/\/api\.twitter\.com/, '').split('?')[0],
          method:   args[0]?.method || 'GET',
          type:     'READ',
          status:   'blocked',
          error:    `LEAK_DETECTED from ${callerLine.trim()}`,
        });

        // In dev mode, throw error; in production, silently block
        if (process.env.NODE_ENV === 'development' || process.env.STRICT_READ_GUARD === 'true') {
          throw new Error(`TWITTER_READ_LEAK: Direct fetch to Twitter READ API detected. Use twitterSafeClient.safeFetch() instead. Caller: ${callerLine.trim()}`);
        }

        // Silently return empty data in production
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
          text: async () => '{"data":[]}',
        });
      }
    }

    return _originalFetch.call(globalThis, url, ...args);
  };

  log.info('🛡️ Twitter API leak detection ENABLED — direct fetch() to Twitter READ endpoints will be intercepted');
}

// ─── Daily usage summary generator (FASE 4) ─────────────────────────────────

const SUMMARY_FILE = path.join(DATA_DIR, 'twitter_usage_summary.json');

/**
 * Generate daily usage summary from the JSONL log
 */
function generateDailySummary(targetDate = null) {
  const date = targetDate || new Date().toISOString().split('T')[0];

  if (!fs.existsSync(USAGE_LOG)) {
    return { date, total_reads_attempted: 0, total_reads_blocked: 0, total_reads_executed: 0, total_writes: 0, top_endpoint: null, top_module: null };
  }

  const lines = fs.readFileSync(USAGE_LOG, 'utf8').split('\n').filter(Boolean);
  const todayEntries = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.timestamp && entry.timestamp.startsWith(date)) {
        todayEntries.push(entry);
      }
    } catch { /* skip malformed */ }
  }

  let reads_attempted = 0;
  let reads_blocked   = 0;
  let reads_executed  = 0;
  let writes          = 0;
  const endpointCounts = {};
  const moduleCounts   = {};

  for (const e of todayEntries) {
    if (e.type === 'READ') {
      reads_attempted++;
      if (e.status === 'blocked') reads_blocked++;
      else reads_executed++;
    } else if (e.type === 'WRITE') {
      writes++;
    }

    const ep = e.endpoint || 'unknown';
    endpointCounts[ep] = (endpointCounts[ep] || 0) + 1;
    const mod = e.module || 'unknown';
    moduleCounts[mod] = (moduleCounts[mod] || 0) + 1;
  }

  const top_endpoint = Object.entries(endpointCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const top_module   = Object.entries(moduleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const summary = {
    date,
    total_reads_attempted: reads_attempted,
    total_reads_blocked:   reads_blocked,
    total_reads_executed:  reads_executed,
    total_writes:          writes,
    top_endpoint,
    top_module,
    entries_count:         todayEntries.length,
    generated_at:          new Date().toISOString(),
  };

  try {
    // Load existing summaries, append/replace today's
    let summaries = {};
    if (fs.existsSync(SUMMARY_FILE)) {
      try { summaries = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8')); } catch { summaries = {}; }
    }
    summaries[date] = summary;
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaries, null, 2));
  } catch (err) {
    log.warn(`Failed to save daily summary: ${err.message}`);
  }

  return summary;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  safeFetch,
  safeSearch,
  safeGetMe,
  logWrite,
  logApiUsage,
  classifyRequest,
  enableLeakDetection,
  generateDailySummary,
  USAGE_LOG,
  SUMMARY_FILE,
};
