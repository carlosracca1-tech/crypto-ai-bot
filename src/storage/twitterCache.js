'use strict';

/**
 * twitterCache.js — Unified Daily Twitter Search → SQLite
 *
 * Runs ALL Twitter search queries ONCE per day (morning), stores results
 * in SQLite via twitterDB.js. All modules read from DB — zero API calls
 * for the rest of the day.
 *
 * Flow:
 *   1. Scheduler calls refreshDailyCache() at 00:05 ART (daily reset)
 *   2. Checks DB search_log — if already searched today, skips
 *   3. Fetches all queries in one batch (~13 API reads)
 *   4. Writes everything to SQLite
 *   5. All modules call getCacheSection() → reads from DB instantly
 *
 * Fallback: if better-sqlite3 isn't available, falls back to JSON file.
 */

const fs   = require('fs');
const path = require('path');
const { TwitterApi } = require('twitter-api-v2');
const { config }             = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { sleep }              = require('../utils/retry');

const log = createModuleLogger('TwitterCache');

// Try to load DB module (graceful fallback if SQLite not available)
let db = null;
try {
  db = require('./twitterDB');
} catch (err) {
  log.warn(`SQLite not available (${err.message}) — using JSON fallback`);
}

const DATA_DIR   = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'twitter_daily_cache.json');

// ─── All search queries consolidated ─────────────────────────────────────────

const QUERIES = {
  engagement: [
    '(Bittensor OR TAO OR "AI agents" OR "AI crypto") -is:retweet lang:en',
    '(RNDR OR FET OR AGIX OR "Render Network" OR "SingularityNET") crypto -is:retweet lang:en',
    '("decentralized AI" OR "on-chain AI" OR "AI infrastructure") crypto -is:retweet lang:en',
  ],
  retweet: [
    '"AI crypto" OR "decentralized AI" -is:retweet lang:en',
    '$TAO OR $FET OR $RNDR OR $NEAR -is:retweet lang:en',
  ],
  follow: [
    '(Bittensor OR TAO OR "AI agents" OR "decentralized AI" OR "crypto AI") -is:retweet lang:en',
    '(RNDR OR FET OR AGIX OR "Render Network" OR "SingularityNET") crypto analysis -is:retweet lang:en',
  ],
};

const QUOTE_TOKENS = ['TAO', 'FET', 'RNDR', 'NEAR', 'AKT', 'AGIX'];

// ─── JSON fallback I/O (same as before, for when SQLite isn't available) ────

function loadJSONCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    if (data.date === today) return data;
    return null;
  } catch { return null; }
}

function saveJSONCache(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

// ─── Read from DB (or JSON fallback) ─────────────────────────────────────────

/**
 * Get a specific section from today's cache.
 * Reads from SQLite if available, otherwise JSON fallback.
 *
 * @param {'engagement'|'retweet'|'follow'|'quoteByToken'} section
 * @returns {Array|Object|null}
 */
function getCacheSection(section) {
  // ── Try SQLite first ──────────────────────────────────────────────────
  if (db) {
    try {
      if (section === 'engagement') {
        const rows = db.getTweets('engagement', { limit: 60 });
        // Normalize DB snake_case → camelCase for consumers
        return rows.length > 0 ? rows.map(normalizeTweetRow) : null;
      }
      if (section === 'retweet') {
        const rows = db.getTweets('retweet', { limit: 40 });
        return rows.length > 0 ? rows.map(normalizeTweetRow) : null;
      }
      if (section === 'follow') {
        const rows = db.getAuthors({ limit: 60 });
        // Normalize authors: DB has flat fields, consumers expect public_metrics
        return rows.length > 0 ? rows.map(r => ({
          id: r.id,
          username: r.username,
          description: r.description,
          public_metrics: {
            followers_count: r.followers,
            following_count: r.following,
            tweet_count: r.tweet_count,
          },
        })) : null;
      }
      if (section === 'quoteByToken') {
        const result = {};
        for (const token of QUOTE_TOKENS) {
          const rows = db.getTweets('quote', { token, limit: 15 });
          if (rows.length > 0) result[token] = rows.map(normalizeTweetRow);
        }
        return Object.keys(result).length > 0 ? result : null;
      }
    } catch (err) {
      log.warn(`DB read error for ${section}: ${err.message}`);
    }
  }

  // ── Fallback to JSON ──────────────────────────────────────────────────
  const cache = loadJSONCache();
  if (!cache) return null;
  return cache[section] || null;
}

/** Normalize DB row (snake_case) → consumer format (camelCase) */
function normalizeTweetRow(row) {
  return {
    id: row.id,
    text: row.text,
    author_id: row.author_id,
    authorUsername: row.author_username,
    authorFollowers: row.author_followers,
    likes: row.likes,
    retweets: row.retweets,
    replies: row.replies,
    created_at: row.created_at,
    score: row.score,
  };
}

function getDailyCache() {
  if (db) {
    const stats = db.getStats();
    if (stats && stats.todayTweets > 0) {
      return { date: new Date().toISOString().split('T')[0], source: 'sqlite', ...stats };
    }
  }
  return loadJSONCache();
}

// ─── API search helper ───────────────────────────────────────────────────────

async function searchQuery(client, query, maxResults = 15, expandUsers = false) {
  const params = {
    max_results: maxResults,
    'tweet.fields': ['public_metrics', 'created_at', 'author_id', 'entities'],
    sort_order: 'relevancy',
  };

  if (expandUsers) {
    params['user.fields'] = ['username', 'public_metrics', 'description', 'verified'];
    params.expansions     = ['author_id'];
  }

  const result = await client.v2.search(query, params);
  const tweets = result.data?.data || [];
  const users  = expandUsers ? (result.data?.includes?.users || []) : [];
  return { tweets, users };
}

// ─── Main: fetch everything once per day ─────────────────────────────────────

/**
 * Fetch all Twitter search data for today in one go.
 * Stores in SQLite (primary) + JSON (backup).
 *
 * @param {object} opts
 * @param {boolean} opts.force - Force refresh even if already searched today
 */
async function refreshDailyCache(opts = {}) {
  // Check if already searched today (DB check)
  if (!opts.force && db && db.wasSearchedToday('all')) {
    log.info('Already searched today (DB) — skipping refresh');
    return getDailyCache();
  }

  // Check JSON fallback too
  if (!opts.force && !db) {
    const existing = loadJSONCache();
    if (existing) {
      log.info('Already searched today (JSON) — skipping refresh');
      return existing;
    }
  }

  // Check if search API is blocked
  let isBlocked = false;
  try {
    const { isSearchApiBlocked } = require('../narrative/twitterScraper');
    isBlocked = isSearchApiBlocked();
  } catch { /* ignore */ }

  if (isBlocked) {
    log.warn('Twitter Search API blocked (402) — cannot refresh cache');
    return getDailyCache();
  }

  const bearerToken = config.twitter.bearerToken;
  if (!bearerToken) {
    log.warn('No TWITTER_BEARER_TOKEN — cannot refresh cache');
    return null;
  }

  const client = new TwitterApi(bearerToken);
  const today  = new Date().toISOString().split('T')[0];

  log.info('═'.repeat(55));
  log.info('DAILY TWITTER SEARCH — One batch for the whole day');
  log.info('═'.repeat(55));

  // Also build JSON cache as backup
  const jsonCache = {
    date: today,
    fetchedAt: new Date().toISOString(),
    engagement: [],
    retweet: [],
    follow: [],
    quoteByToken: {},
  };

  let totalQueries = 0;
  let totalTweets  = 0;

  // ── Engagement queries ──────────────────────────────────────────────────
  for (const query of QUERIES.engagement) {
    try {
      log.info(`[engagement] "${query.substring(0, 50)}..."`);
      const { tweets, users } = await searchQuery(client, query, 15, true);
      const enriched = tweets.map(t => {
        const author = users.find(u => u.id === t.author_id) || {};
        return {
          id: t.id,
          text: t.text,
          author_id: t.author_id,
          authorUsername: author.username || null,
          authorFollowers: author.public_metrics?.followers_count || 0,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          created_at: t.created_at,
        };
      });

      if (db) db.upsertTweets(enriched, 'engagement');
      jsonCache.engagement.push(...enriched);
      totalQueries++;
      totalTweets += enriched.length;
      await sleep(1500);
    } catch (err) {
      handleSearchError(err, 'engagement');
    }
  }

  // ── Retweet queries ─────────────────────────────────────────────────────
  for (const query of QUERIES.retweet) {
    try {
      log.info(`[retweet] "${query.substring(0, 50)}..."`);
      const { tweets, users } = await searchQuery(client, query, 15, true);
      const enriched = tweets.map(t => {
        const author = users.find(u => u.id === t.author_id) || {};
        return {
          id: t.id,
          text: t.text,
          author_id: t.author_id,
          authorUsername: author.username || null,
          authorFollowers: author.public_metrics?.followers_count || 0,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          created_at: t.created_at,
        };
      });

      if (db) db.upsertTweets(enriched, 'retweet');
      jsonCache.retweet.push(...enriched);
      totalQueries++;
      totalTweets += enriched.length;
      await sleep(1500);
    } catch (err) {
      handleSearchError(err, 'retweet');
    }
  }

  // ── Follow queries (extract authors) ──────────────────────────────────
  const seenAuthors = new Set();
  for (const query of QUERIES.follow) {
    try {
      log.info(`[follow] "${query.substring(0, 50)}..."`);
      const { tweets, users } = await searchQuery(client, query, 20, true);
      const newUsers = users.filter(u => {
        if (seenAuthors.has(u.id)) return false;
        seenAuthors.add(u.id);
        return true;
      });

      if (db) db.upsertAuthors(newUsers);
      jsonCache.follow.push(...newUsers.map(u => ({
        id: u.id,
        username: u.username,
        description: u.description || '',
        public_metrics: u.public_metrics || {},
      })));
      totalQueries++;
      await sleep(1500);
    } catch (err) {
      handleSearchError(err, 'follow');
    }
  }

  // ── Quote tweet token searches ──────────────────────────────────────────
  for (const token of QUOTE_TOKENS) {
    try {
      const query = `$${token} -is:retweet -is:reply lang:en`;
      log.info(`[quote] "${query}"`);
      const { tweets } = await searchQuery(client, query, 15, false);
      const enriched = tweets.map(t => ({
        id: t.id,
        text: t.text,
        likes: t.public_metrics?.like_count || 0,
        retweets: t.public_metrics?.retweet_count || 0,
        created_at: t.created_at,
      }));

      if (db) db.upsertTweets(enriched, 'quote', token);
      jsonCache.quoteByToken[token] = enriched;
      totalQueries++;
      totalTweets += enriched.length;
      await sleep(1500);
    } catch (err) {
      handleSearchError(err, `quote:${token}`);
    }
  }

  // ── Log search completion ──────────────────────────────────────────────
  if (db) db.logSearch('all', totalQueries, totalTweets);
  saveJSONCache(jsonCache);  // JSON backup always

  log.info('═'.repeat(55));
  log.info(`SEARCH COMPLETE | ${totalQueries} queries | ${totalTweets} tweets`);
  log.info(`  Storage: ${db ? 'SQLite + JSON backup' : 'JSON only'}`);
  log.info(`  engagement: ${jsonCache.engagement.length} | retweet: ${jsonCache.retweet.length}`);
  log.info(`  follow: ${jsonCache.follow.length} authors | quote tokens: ${QUOTE_TOKENS.length}`);
  if (db) {
    const stats = db.getStats();
    if (stats) log.info(`  DB total: ${stats.totalTweets} tweets | ${stats.dbSizeMB} MB`);
  }
  log.info('═'.repeat(55));

  return getDailyCache();
}

function handleSearchError(err, section) {
  if (err.message?.includes('402')) {
    try {
      const { markSearchApiBlocked } = require('../narrative/twitterScraper');
      markSearchApiBlocked(`402 in twitterCache [${section}]`);
    } catch { /* ignore */ }
  } else if (err.code === 429) {
    log.warn(`[${section}] Rate limit — pausing remaining searches`);
  } else {
    log.error(`[${section}] Search error: ${err.message}`);
  }
}

module.exports = {
  refreshDailyCache,
  getDailyCache,
  getCacheSection,
  QUOTE_TOKENS,
};
