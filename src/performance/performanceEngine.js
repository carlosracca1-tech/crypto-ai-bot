'use strict';

/**
 * performanceEngine.js
 *
 * Fetches real engagement metrics for published tweets via Twitter API v2,
 * computes engagement scores, aggregates by type/time/token and detects
 * patterns that drive the feedback loop.
 *
 * engagement_score = (likes × 1) + (replies × 2) + (retweets × 3)
 */

const fs   = require('fs');
const path = require('path');
const { createModuleLogger } = require('../utils/logger');
const { withRetry }          = require('../utils/retry');
const { config }             = require('../config');
const { safeFetch, logApiUsage } = require('../lib/twitterSafeClient');

let twitterDB = null;
try { twitterDB = require('../storage/twitterDB'); } catch { /* SQLite not available */ }

const log = createModuleLogger('PerformanceEngine');

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR       = path.join(process.cwd(), 'data');
const PERF_LOG       = path.join(DATA_DIR, 'performance_log.json');
const PIPELINE_LOG   = path.join(DATA_DIR, 'pipeline_runs.json');

// ─── Score formula ────────────────────────────────────────────────────────────

const SCORE_WEIGHTS = { likes: 1, replies: 2, retweets: 3, impressions: 0.05 };

function computeEngagementScore(metrics) {
  return (
    (metrics.likes        || 0) * SCORE_WEIGHTS.likes +
    (metrics.replies      || 0) * SCORE_WEIGHTS.replies +
    (metrics.retweets     || 0) * SCORE_WEIGHTS.retweets +
    (metrics.impressions  || 0) * SCORE_WEIGHTS.impressions
  );
}

// ─── Growth value score ───────────────────────────────────────────────────────

/**
 * Compute a secondary growth_value_score that estimates authority-building
 * potential beyond raw engagement. Factors:
 *   - Reply depth ratio  — replies / max(impressions, 1) × 1000
 *   - Retweet share rate — retweets / max(impressions, 1) × 1000
 *   - Quote signal       — quotes × 4 (authority amplifier)
 *   - Hook strength      — pattern-detected hook type adds 5-15 pts
 *   - Callback usage     — tweet referencing prior analysis adds 10 pts
 *   - Core token focus   — mentioning core watchlist tokens adds 5 pts
 *
 * Range: 0–100 (normalized).
 *
 * @param {object} metrics  - { likes, replies, retweets, quotes, impressions }
 * @param {string} content  - tweet text
 * @returns {number} growth_value_score 0–100
 */
const CORE_TOKENS = ['TAO', 'RNDR', 'FET', 'AKT', 'AGIX', 'INJ'];

const HOOK_PATTERNS = {
  contrarian:  /\b(wrong|consensus|everyone thinks|market is missing|but actually)\b/i,
  tension:     /\b(vs\.?|against|while|despite|even as|yet)\b/i,
  data_shock:  /\b(\d{1,3}(\.\d+)?%|\$\d|[0-9]+[kKmMbB])\b/,
  question:    /\?/,
};

const CALLBACK_PATTERNS = [
  /\b(called (it|this)|as (I |we )?said|last (week|month|time)|played out|exactly as)\b/i,
  /\b(remember|back in|from (the )?(last|previous|earlier))\b/i,
];

function computeGrowthValueScore(metrics, content = '') {
  const imp = metrics.impressions || 1; // avoid div/0

  // Ratio signals (scaled per 1000 impressions)
  const replyRatio   = ((metrics.replies  || 0) / imp) * 1000;
  const rtRatio      = ((metrics.retweets || 0) / imp) * 1000;
  const quoteSignal  = (metrics.quotes    || 0) * 4;

  // Hook bonus
  let hookBonus = 0;
  if (HOOK_PATTERNS.contrarian.test(content))  hookBonus = 15;
  else if (HOOK_PATTERNS.tension.test(content)) hookBonus = 10;
  else if (HOOK_PATTERNS.data_shock.test(content)) hookBonus = 8;
  else if (HOOK_PATTERNS.question.test(content))   hookBonus = 5;

  // Callback bonus
  const callbackBonus = CALLBACK_PATTERNS.some(p => p.test(content)) ? 10 : 0;

  // Core token bonus
  const tokenBonus = CORE_TOKENS.some(t => new RegExp(`\\b${t}\\b`, 'i').test(content)) ? 5 : 0;

  const raw = replyRatio * 10 + rtRatio * 8 + quoteSignal + hookBonus + callbackBonus + tokenBonus;

  // Normalize to 0–100
  return parseFloat(Math.min(100, raw).toFixed(2));
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function loadPerformanceLog() {
  try {
    if (!fs.existsSync(PERF_LOG)) return [];
    return JSON.parse(fs.readFileSync(PERF_LOG, 'utf8'));
  } catch {
    return [];
  }
}

function savePerformanceLog(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Cap at 500 entries — last 500 tweets is plenty for analysis
  const trimmed = entries.slice(-500);
  fs.writeFileSync(PERF_LOG, JSON.stringify(trimmed, null, 2));
}

// ─── Collect published tweet IDs from pipeline log ───────────────────────────

function getPublishedTweetIds(lookbackHours = 48) {
  try {
    if (!fs.existsSync(PIPELINE_LOG)) return [];
    const data = JSON.parse(fs.readFileSync(PIPELINE_LOG, 'utf8'));
    const runs = Array.isArray(data) ? data : (data.runs || []);
    const cutoff = Date.now() - lookbackHours * 3600 * 1000;

    const ids = [];
    for (const run of runs) {
      if (!run.publishedTweets) continue;
      for (const tweet of run.publishedTweets) {
        if (!tweet.tweetId || !tweet.postedAt) continue;
        if (new Date(tweet.postedAt).getTime() > cutoff) {
          ids.push({
            tweetId:   tweet.tweetId,
            type:      tweet.type || 'unknown',
            content:   tweet.content || '',
            postedAt:  tweet.postedAt,
            tokens:    tweet.tokens || [],
            window:    tweet.window || null,
          });
        }
      }
    }
    return ids;
  } catch (err) {
    log.warn(`Cannot load pipeline log: ${err.message}`);
    return [];
  }
}

// ─── Twitter API v2 metrics fetch ─────────────────────────────────────────────

async function fetchTweetMetrics(tweetIds) {
  if (!tweetIds.length) return {};

  // ── GUARDIA OBLIGATORIA: bloquear READ si readsDisabled ──────────────────
  if (config.twitter.readsDisabled) {
    logApiUsage({
      module: 'PerformanceEngine',
      function: 'fetchTweetMetrics',
      endpoint: '/2/tweets',
      method: 'GET',
      type: 'READ',
      status: 'blocked',
      ids_count: tweetIds.length,
    });
    log.info(`TWITTER_READ_BLOCKED | PerformanceEngine.fetchTweetMetrics | reason: readsDisabled | ids: ${tweetIds.length}`);
    return {};
  }

  const bearerToken = config.twitter.bearerToken || process.env.TWITTER_BEARER_TOKEN;
  if (!bearerToken) {
    log.warn('TWITTER_BEARER_TOKEN not set — cannot fetch metrics');
    return {};
  }

  const results = {};

  // Batch in groups of 100 (Twitter API limit)
  const batches = [];
  for (let i = 0; i < tweetIds.length; i += 100) {
    batches.push(tweetIds.slice(i, i + 100));
  }

  for (const batch of batches) {
    const ids = batch.join(',');
    const url = `https://api.twitter.com/2/tweets?ids=${ids}&tweet.fields=public_metrics,created_at,text`;

    try {
      const data = await withRetry(async () => {
        const res = await safeFetch(url, {
          headers: { Authorization: `Bearer ${bearerToken}` },
        }, { module: 'PerformanceEngine', function: 'fetchTweetMetrics', ids_count: batch.length });
        if (!res.ok) throw new Error(`Twitter API ${res.status}: ${res.statusText}`);
        return res.json();
      }, { label: 'fetchTweetMetrics', retries: 2, delay: 3000 });

      if (data.data) {
        for (const tweet of data.data) {
          const m = tweet.public_metrics || {};
          results[tweet.id] = {
            likes:       m.like_count      || 0,
            replies:     m.reply_count     || 0,
            retweets:    m.retweet_count   || 0,
            quotes:      m.quote_count     || 0,
            impressions: m.impression_count || 0, // requires Elevated access
          };
        }
      }
    } catch (err) {
      log.error(`Failed to fetch metrics batch: ${err.message}`);
    }
  }

  return results;
}

// ─── Core: fetch + update performance log ─────────────────────────────────────

/**
 * Main function. Pulls metrics for recent published tweets and updates the
 * performance log. Skips tweets already tracked in the last 4 hours to avoid
 * stale updates on very fresh tweets.
 */
async function updatePerformanceLog() {
  log.info('Updating performance log from Twitter API...');

  const published = getPublishedTweetIds(72);
  if (!published.length) {
    log.info('No published tweets found in last 72h');
    return [];
  }

  const existingLog = loadPerformanceLog();
  const existingIds = new Set(existingLog.map(e => e.tweet_id));

  // Determine which tweets to refresh: all published ones (update existing + add new)
  const idsToFetch = published.map(p => p.tweetId);
  const metrics    = await fetchTweetMetrics(idsToFetch);

  const now     = Date.now();
  const updated = [];

  for (const pub of published) {
    const m = metrics[pub.tweetId];
    if (!m) continue;

    const score       = computeEngagementScore(m);
    const growthScore = computeGrowthValueScore(m, pub.content);
    const entry = {
      tweet_id:     pub.tweetId,
      type:         pub.type,
      content:      pub.content,
      timestamp:    pub.postedAt,
      fetched_at:   new Date().toISOString(),
      tokens:       pub.tokens,
      window:       pub.window,
      metrics: {
        likes:               m.likes,
        replies:             m.replies,
        retweets:            m.retweets,
        quotes:              m.quotes,
        impressions:         m.impressions,
        engagement_score:    parseFloat(score.toFixed(2)),
        growth_value_score:  growthScore,
      },
    };
    updated.push(entry);
  }

  // Merge: replace existing entries for same tweet_id, append new ones
  const merged = [...existingLog];
  for (const entry of updated) {
    const idx = merged.findIndex(e => e.tweet_id === entry.tweet_id);
    if (idx >= 0) {
      merged[idx] = entry;
    } else {
      merged.push(entry);
    }
  }

  merged.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  savePerformanceLog(merged);

  // Also write to SQLite for historical analysis
  if (twitterDB && updated.length > 0) {
    try {
      twitterDB.upsertMetrics(updated);
    } catch (err) {
      log.warn(`Failed to write metrics to SQLite: ${err.message}`);
    }
  }

  log.info(`Performance log updated: ${updated.length} entries refreshed, ${merged.length} total`);
  return merged;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Aggregates performance data by tweet type.
 * Returns average score, sample count, and best individual tweet per type.
 */
function aggregateByType(entries) {
  const byType = {};

  for (const e of entries) {
    const t = e.type || 'unknown';
    if (!byType[t]) byType[t] = { scores: [], tweets: [] };
    byType[t].scores.push(e.metrics.engagement_score);
    byType[t].tweets.push(e);
  }

  const result = {};
  for (const [type, data] of Object.entries(byType)) {
    const avg = data.scores.reduce((s, v) => s + v, 0) / data.scores.length;
    result[type] = {
      avg_score:  parseFloat(avg.toFixed(2)),
      count:      data.scores.length,
      best_tweet: data.tweets.sort((a, b) => b.metrics.engagement_score - a.metrics.engagement_score)[0],
      worst_tweet: data.tweets.sort((a, b) => a.metrics.engagement_score - b.metrics.engagement_score)[0],
    };
  }

  return result;
}

/**
 * Aggregates by ART time window (based on tweet timestamp).
 */
function aggregateByTimeWindow(entries) {
  const ART_OFFSET = -3;
  const windows = {};

  for (const e of entries) {
    const artHour = (new Date(e.timestamp).getUTCHours() + 24 + ART_OFFSET) % 24;

    let windowLabel = 'other';
    if      (artHour >= 8  && artHour < 10)  windowLabel = '08:00-09:30';
    else if (artHour >= 10 && artHour < 12)  windowLabel = '10:30-12:00';
    else if (artHour >= 13 && artHour < 15)  windowLabel = '13:30-15:00';
    else if (artHour >= 16 && artHour < 18)  windowLabel = '16:30-18:00';
    else if (artHour >= 19 && artHour < 21)  windowLabel = '19:00-20:30';
    else if (artHour >= 21 && artHour < 23)  windowLabel = '21:00-22:30';

    if (!windows[windowLabel]) windows[windowLabel] = { scores: [] };
    windows[windowLabel].scores.push(e.metrics.engagement_score);
  }

  const result = {};
  for (const [window, data] of Object.entries(windows)) {
    result[window] = {
      avg_score: parseFloat((data.scores.reduce((s, v) => s + v, 0) / data.scores.length).toFixed(2)),
      count:     data.scores.length,
    };
  }
  return result;
}

/**
 * Aggregates by token mentioned in tweet.
 */
function aggregateByToken(entries) {
  const byToken = {};
  const TOKEN_REGEX = /\b(BTC|ETH|SOL|TAO|RNDR|FET|AGIX|INJ|NEAR|ARB|OP|AVAX|LINK|DOT)\b/gi;

  for (const e of entries) {
    const found = [...new Set((e.content.match(TOKEN_REGEX) || []).map(t => t.toUpperCase()))];
    for (const token of found) {
      if (!byToken[token]) byToken[token] = { scores: [], count: 0 };
      byToken[token].scores.push(e.metrics.engagement_score);
      byToken[token].count++;
    }
  }

  const result = {};
  for (const [token, data] of Object.entries(byToken)) {
    result[token] = {
      avg_score: parseFloat((data.scores.reduce((s, v) => s + v, 0) / data.scores.length).toFixed(2)),
      count:     data.count,
    };
  }
  return result;
}

// ─── Pattern detection ────────────────────────────────────────────────────────

/**
 * Returns structured insights about what's working.
 * @param {object[]} entries - performance log entries
 * @returns {object} insights
 */
function detectPatterns(entries) {
  if (!entries.length) {
    return {
      best_type:         null,
      worst_type:        null,
      best_time_window:  null,
      top_tokens:        [],
      avg_score:         0,
      total_tweets:      0,
      trend:             'insufficient_data',
    };
  }

  const byType   = aggregateByType(entries);
  const byWindow = aggregateByTimeWindow(entries);
  const byToken  = aggregateByToken(entries);

  // Best/worst type
  const typesSorted = Object.entries(byType)
    .filter(([, v]) => v.count >= 2) // need at least 2 data points
    .sort(([, a], [, b]) => b.avg_score - a.avg_score);

  const best_type  = typesSorted[0]?.[0]   || null;
  const worst_type = typesSorted[typesSorted.length - 1]?.[0] || null;

  // Best time window
  const windowsSorted = Object.entries(byWindow)
    .filter(([, v]) => v.count >= 1)
    .sort(([, a], [, b]) => b.avg_score - a.avg_score);
  const best_time_window = windowsSorted[0]?.[0] || null;

  // Top tokens
  const top_tokens = Object.entries(byToken)
    .filter(([, v]) => v.count >= 2)
    .sort(([, a], [, b]) => b.avg_score - a.avg_score)
    .slice(0, 5)
    .map(([token]) => token);

  // Overall average
  const avg_score = entries.length
    ? parseFloat((entries.reduce((s, e) => s + e.metrics.engagement_score, 0) / entries.length).toFixed(2))
    : 0;

  // Trend: compare last 7 entries vs previous 7
  const last7  = entries.slice(-7).map(e => e.metrics.engagement_score);
  const prev7  = entries.slice(-14, -7).map(e => e.metrics.engagement_score);
  const avgL7  = last7.length  ? last7.reduce((a, b) => a + b, 0)  / last7.length  : 0;
  const avgP7  = prev7.length  ? prev7.reduce((a, b) => a + b, 0)  / prev7.length  : 0;
  const trend  = avgP7 === 0 ? 'unknown'
    : avgL7 > avgP7 * 1.1 ? 'improving'
    : avgL7 < avgP7 * 0.9 ? 'degrading'
    : 'stable';

  return {
    best_type,
    worst_type,
    best_time_window,
    top_tokens,
    avg_score,
    total_tweets:  entries.length,
    trend,
    by_type:       byType,
    by_window:     byWindow,
    by_token:      byToken,
    best_tweet:    [...entries].sort((a, b) => b.metrics.engagement_score - a.metrics.engagement_score)[0] || null,
    worst_tweet:   [...entries].sort((a, b) => a.metrics.engagement_score - b.metrics.engagement_score)[0] || null,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run full performance update + analysis.
 * Returns patterns/insights object.
 */
async function runPerformanceEngine() {
  // ── DOBLE PROTECCIÓN: si readsDisabled, usar datos locales sin API calls ──
  if (config.twitter.readsDisabled) {
    log.info('TWITTER_READ_BLOCKED | PerformanceEngine.runPerformanceEngine | reason: readsDisabled — using local data only');
    const entries  = loadPerformanceLog();
    const patterns = detectPatterns(entries);
    log.info(`Performance analysis (local only): ${entries.length} entries, trend: ${patterns.trend}`);
    return patterns;
  }

  try {
    const entries  = await updatePerformanceLog();
    const patterns = detectPatterns(entries);

    log.info(`Performance analysis complete:`);
    log.info(`  Best type: ${patterns.best_type} | Worst: ${patterns.worst_type}`);
    log.info(`  Best window: ${patterns.best_time_window}`);
    log.info(`  Top tokens: ${patterns.top_tokens.join(', ')}`);
    log.info(`  Trend: ${patterns.trend} | Avg score: ${patterns.avg_score}`);

    return patterns;
  } catch (err) {
    log.error(`Performance engine failed: ${err.message}`);
    return null;
  }
}

/**
 * Get latest patterns from existing log without re-fetching.
 */
function getLatestPatterns() {
  const entries = loadPerformanceLog();
  return detectPatterns(entries);
}

module.exports = {
  runPerformanceEngine,
  getLatestPatterns,
  updatePerformanceLog,
  fetchTweetMetrics,
  detectPatterns,
  aggregateByType,
  computeEngagementScore,
  computeGrowthValueScore,
  loadPerformanceLog,
};
