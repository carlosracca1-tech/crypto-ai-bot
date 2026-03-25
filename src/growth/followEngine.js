'use strict';

/**
 * Follow Engine — Account Growth Strategy
 *
 * Encuentra cuentas relevantes en AI + crypto y las sigue.
 * Límites: 20-50 follows/día. Anti-spam. No re-follow en 30 días.
 *
 * Estrategia:
 *   1. Buscar tweets de alta calidad sobre AI + crypto
 *   2. Extraer autores únicos
 *   3. Filtrar: mínimo followers, engagement, no bots, no ya seguidos
 *   4. Seguir hasta el límite diario
 *   5. Persistir log en data/follow_log.json
 */

const fs   = require('fs');
const path = require('path');
const { TwitterApi } = require('twitter-api-v2');
const { config }             = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { sleep }              = require('../utils/retry');
let isSearchApiBlocked;
try { isSearchApiBlocked = require('../narrative/twitterScraper').isSearchApiBlocked; } catch { isSearchApiBlocked = () => false; }

const log = createModuleLogger('FollowEngine');

// ─── Config ────────────────────────────────────────────────────────────────────

const DAILY_FOLLOW_LIMIT  = 15;   // reduced from 40 to save API quota
const MIN_FOLLOWERS       = 500;  // mínimo de followers para considerar
const MAX_FOLLOWING_RATIO = 5.0;  // max following/followers ratio (filtra cuentas spam)
const REFOLLOW_DAYS       = 30;   // no re-seguir a alguien por N días
const DELAY_BETWEEN_MS    = 5000; // pausa entre follows (anti-spam)

const LOG_FILE = path.join(process.cwd(), 'data', 'follow_log.json');

// ─── Queries de búsqueda ────────────────────────────────────────────────────────

// Consolidated from 4 to 2 broader queries to save API reads
const FOLLOW_QUERIES = [
  '(Bittensor OR TAO OR "AI agents" OR "decentralized AI" OR "crypto AI") -is:retweet lang:en min_faves:15',
  '(RNDR OR FET OR AGIX OR "Render Network" OR "SingularityNET") crypto analysis -is:retweet lang:en min_faves:10',
];

// ─── Persistencia ──────────────────────────────────────────────────────────────

function loadLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return { date: null, follows: [], allTime: [] };
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch { return { date: null, follows: [], allTime: [] }; }
}

function saveLog(data) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
  } catch (err) { log.error(`Error guardando follow log: ${err.message}`); }
}

function getTodayLog() {
  const stored = loadLog();
  const today  = new Date().toISOString().split('T')[0];
  if (stored.date !== today) {
    return { date: today, follows: [], allTime: stored.allTime || [] };
  }
  return stored;
}

// ─── Filtros de calidad ────────────────────────────────────────────────────────

function isQualityAccount(user) {
  const followers  = user.public_metrics?.followers_count || 0;
  const following  = user.public_metrics?.following_count || 1;
  const tweetCount = user.public_metrics?.tweet_count     || 0;

  if (followers < MIN_FOLLOWERS)             return false;
  if (following / Math.max(followers, 1) > MAX_FOLLOWING_RATIO) return false;
  if (tweetCount < 50)                       return false; // muy nueva o inactiva

  // Detectar bots: ratio de followers muy alto (comprado) con engagement bajo
  if (followers > 100000 && following < 100) return false; // likely celeb/brand, skip

  return true;
}

function wasRecentlyFollowed(userId, allTimeLog) {
  const cutoff = Date.now() - REFOLLOW_DAYS * 24 * 3600 * 1000;
  return allTimeLog.some(e => e.userId === userId && new Date(e.followedAt).getTime() > cutoff);
}

// ─── Main engine ───────────────────────────────────────────────────────────────

async function runFollowEngine(opts = {}) {
  const dryRun = opts.dryRun ?? config.content.dryRun;

  log.info('═'.repeat(55));
  log.info(`FOLLOW ENGINE | Límite: ${DAILY_FOLLOW_LIMIT}/día | DryRun: ${dryRun}`);
  log.info('═'.repeat(55));

  const bearerToken = config.twitter.bearerToken;
  const { appKey, appSecret, accessToken, accessSecret } = config.twitter;

  if (!bearerToken || !accessToken || !accessSecret) {
    log.warn('Credenciales de Twitter insuficientes para follow engine');
    return { followed: 0, skipped: 0, error: 'missing credentials' };
  }

  // Check if search API is blocked (402)
  if (isSearchApiBlocked()) {
    log.info('Twitter Search API bloqueada (402) — skipping follow engine');
    return { followed: 0, skipped: 0, reason: 'api_blocked' };
  }

  const todayLog = getTodayLog();

  if (todayLog.follows.length >= DAILY_FOLLOW_LIMIT) {
    log.info(`Límite diario alcanzado (${DAILY_FOLLOW_LIMIT} follows). Skipping.`);
    return { followed: todayLog.follows.length, skipped: 0, reason: 'daily_limit' };
  }

  const remaining     = DAILY_FOLLOW_LIMIT - todayLog.follows.length;
  const searchClient  = new TwitterApi(bearerToken);
  const followClient  = new TwitterApi({ appKey, appSecret, accessToken, accessSecret });

  // Obtener ID propio (para no seguirse a sí mismo)
  let myUserId;
  try {
    const me = await followClient.v1.verifyCredentials();
    myUserId = me.id_str;
    log.info(`Siguiendo como: @${me.screen_name} (${myUserId})`);
  } catch (err) {
    log.error(`Error verificando credenciales: ${err.message}`);
    return { followed: 0, error: err.message };
  }

  // Buscar candidatos
  const alreadyFollowed = new Set([
    ...todayLog.follows.map(f => f.userId),
    ...todayLog.allTime.map(f => f.userId),
  ]);
  alreadyFollowed.add(myUserId);

  const candidates = [];
  const seenIds    = new Set();

  for (const query of FOLLOW_QUERIES) {
    if (candidates.length >= remaining * 3) break; // ya tenemos suficientes candidatos

    try {
      log.info(`Buscando: "${query.substring(0, 60)}..."`);

      const results = await searchClient.v2.search(query, {
        max_results: 20,
        'tweet.fields': ['author_id'],
        'user.fields':  ['username', 'public_metrics', 'description'],
        'expansions':   ['author_id'],
        sort_order:     'relevancy',
      });

      const users = results.data?.includes?.users || [];
      for (const user of users) {
        if (seenIds.has(user.id))             continue;
        if (alreadyFollowed.has(user.id))     continue;
        if (wasRecentlyFollowed(user.id, todayLog.allTime)) continue;
        if (!isQualityAccount(user))          continue;
        seenIds.add(user.id);
        candidates.push(user);
      }

      log.info(`  → ${users.length} usuarios encontrados, ${candidates.length} candidatos totales`);
      await sleep(1500);
    } catch (err) {
      if (err.code === 429) {
        log.warn('Rate limit en búsqueda — deteniendo recolección');
        break;
      }
      log.error(`Error en query: ${err.message}`);
    }
  }

  // Sort by followers (highest first for maximum visibility)
  candidates.sort((a, b) => (b.public_metrics?.followers_count || 0) - (a.public_metrics?.followers_count || 0));

  log.info(`${candidates.length} candidatos listos. Siguiendo hasta ${remaining} más...`);

  const results = { followed: 0, skipped: 0, errors: 0 };

  for (const user of candidates.slice(0, remaining)) {
    log.info(`  → @${user.username} (${formatNum(user.public_metrics?.followers_count)} followers)`);

    if (!dryRun) {
      try {
        await followClient.v1.createFriendship({ user_id: user.id });

        const entry = {
          userId:     user.id,
          username:   user.username,
          followers:  user.public_metrics?.followers_count || 0,
          followedAt: new Date().toISOString(),
        };
        todayLog.follows.push(entry);
        todayLog.allTime.push(entry);
        // Keep allTime manageable (last 3000)
        if (todayLog.allTime.length > 3000) todayLog.allTime = todayLog.allTime.slice(-3000);

        saveLog(todayLog);
        results.followed++;
        log.info(`  ✅ Seguido @${user.username}`);

        await sleep(DELAY_BETWEEN_MS);
      } catch (err) {
        if (err.message?.includes('already') || err.code === 327) {
          // Already following — add to allTime to avoid retrying
          todayLog.allTime.push({ userId: user.id, username: user.username, followedAt: new Date().toISOString() });
          saveLog(todayLog);
          results.skipped++;
        } else if (err.code === 429 || err.message?.includes('Too Many')) {
          log.error('Rate limit de following alcanzado — deteniendo por hoy');
          break;
        } else {
          log.error(`  ❌ Error siguiendo @${user.username}: ${err.message}`);
          results.errors++;
        }
      }
    } else {
      log.info(`  [DRY RUN] No se siguió @${user.username}`);
      results.followed++;
      await sleep(200);
    }
  }

  log.info('═'.repeat(55));
  log.info(`FOLLOW ENGINE COMPLETADO | Seguidos: ${results.followed} | Skipped: ${results.skipped} | Total día: ${todayLog.follows.length}`);
  log.info('═'.repeat(55));

  return results;
}

function formatNum(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

module.exports = { runFollowEngine };
