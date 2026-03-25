'use strict';

/**
 * twitterDB.js — SQLite storage layer for Twitter data
 *
 * Single daily search → stored here → all modules read from DB.
 * No more repeated API calls. Historical data accumulates for analytics.
 *
 * Tables:
 *   tweets          — All discovered tweets (engagement, retweet, quote candidates)
 *   tweet_authors   — Author profiles for follow engine
 *   tweet_metrics   — Our published tweets' performance metrics over time
 *   search_log      — Track when we last fetched each search category
 */

const path = require('path');
const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('TwitterDB');

const DB_PATH = path.join(process.cwd(), 'data', 'twitter.db');

let _db = null;
let _initFailed = false;  // Only log the error once

// ─── Lazy init (only loads better-sqlite3 when first needed) ─────────────────

function getDB() {
  if (_db) return _db;
  if (_initFailed) return null;  // Don't retry if already failed

  try {
    const Database = require('better-sqlite3');
    _db = new Database(DB_PATH);

    // Performance optimizations
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('cache_size = -8000');  // 8MB cache

    initSchema();
    log.info(`SQLite database initialized at ${DB_PATH}`);
    return _db;
  } catch (err) {
    _initFailed = true;
    log.warn(`SQLite not available — using JSON fallback (${err.message})`);
    return null;
  }
}

// ─── Schema ──────────────────────────────────────────────────────────────────

function initSchema() {
  const db = _db;

  db.exec(`
    CREATE TABLE IF NOT EXISTS tweets (
      id              TEXT PRIMARY KEY,
      text            TEXT NOT NULL,
      author_id       TEXT,
      author_username TEXT,
      author_followers INTEGER DEFAULT 0,
      likes           INTEGER DEFAULT 0,
      retweets        INTEGER DEFAULT 0,
      replies         INTEGER DEFAULT 0,
      quotes          INTEGER DEFAULT 0,
      created_at      TEXT,
      fetched_at      TEXT NOT NULL,
      fetched_date    TEXT NOT NULL,
      category        TEXT NOT NULL,
      token           TEXT,
      score           REAL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_tweets_category_date ON tweets(category, fetched_date);
    CREATE INDEX IF NOT EXISTS idx_tweets_token ON tweets(token);
    CREATE INDEX IF NOT EXISTS idx_tweets_fetched_date ON tweets(fetched_date);

    CREATE TABLE IF NOT EXISTS tweet_authors (
      id              TEXT PRIMARY KEY,
      username        TEXT,
      description     TEXT,
      followers       INTEGER DEFAULT 0,
      following       INTEGER DEFAULT 0,
      tweet_count     INTEGER DEFAULT 0,
      verified        INTEGER DEFAULT 0,
      fetched_at      TEXT NOT NULL,
      fetched_date    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_authors_date ON tweet_authors(fetched_date);
    CREATE INDEX IF NOT EXISTS idx_authors_followers ON tweet_authors(followers);

    CREATE TABLE IF NOT EXISTS tweet_metrics (
      tweet_id        TEXT NOT NULL,
      type            TEXT,
      content         TEXT,
      posted_at       TEXT,
      fetched_at      TEXT NOT NULL,
      likes           INTEGER DEFAULT 0,
      replies         INTEGER DEFAULT 0,
      retweets        INTEGER DEFAULT 0,
      quotes          INTEGER DEFAULT 0,
      impressions     INTEGER DEFAULT 0,
      engagement_score REAL DEFAULT 0,
      growth_score    REAL DEFAULT 0,
      tokens          TEXT,
      window          TEXT,
      PRIMARY KEY (tweet_id, fetched_at)
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_posted ON tweet_metrics(posted_at);

    CREATE TABLE IF NOT EXISTS search_log (
      category        TEXT NOT NULL,
      search_date     TEXT NOT NULL,
      fetched_at      TEXT NOT NULL,
      query_count     INTEGER DEFAULT 0,
      tweet_count     INTEGER DEFAULT 0,
      PRIMARY KEY (category, search_date)
    );
  `);
}

// ─── Tweet CRUD ──────────────────────────────────────────────────────────────

/**
 * Upsert a batch of tweets into the DB.
 * @param {Array} tweets - Array of tweet objects
 * @param {string} category - 'engagement' | 'retweet' | 'quote' | 'narrative'
 * @param {string|null} token - Token symbol if category is 'quote'
 */
function upsertTweets(tweets, category, token = null) {
  const db = getDB();
  if (!db) return 0;

  const today = new Date().toISOString().split('T')[0];
  const now   = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tweets
      (id, text, author_id, author_username, author_followers, likes, retweets, replies, quotes, created_at, fetched_at, fetched_date, category, token, score)
    VALUES
      (@id, @text, @author_id, @author_username, @author_followers, @likes, @retweets, @replies, @quotes, @created_at, @fetched_at, @fetched_date, @category, @token, @score)
  `);

  const insertMany = db.transaction((items) => {
    let count = 0;
    for (const t of items) {
      stmt.run({
        id:               t.id,
        text:             t.text || '',
        author_id:        t.author_id || null,
        author_username:  t.authorUsername || t.author_username || null,
        author_followers: t.authorFollowers || t.author_followers || 0,
        likes:            t.likes || (t.public_metrics?.like_count) || 0,
        retweets:         t.retweets || (t.public_metrics?.retweet_count) || 0,
        replies:          t.replies || (t.public_metrics?.reply_count) || 0,
        quotes:           t.quotes || (t.public_metrics?.quote_count) || 0,
        created_at:       t.created_at || null,
        fetched_at:       now,
        fetched_date:     today,
        category,
        token:            token || null,
        score:            t.score || 0,
      });
      count++;
    }
    return count;
  });

  const count = insertMany(tweets);
  log.info(`Upserted ${count} tweets [${category}${token ? ':' + token : ''}]`);
  return count;
}

/**
 * Get tweets by category for today (or a specific date).
 * @param {string} category
 * @param {object} opts
 * @param {string} opts.date - Date string YYYY-MM-DD (default: today)
 * @param {string} opts.token - Filter by token (for quote category)
 * @param {number} opts.minLikes - Minimum likes
 * @param {number} opts.minFollowers - Minimum author followers
 * @param {number} opts.limit - Max results
 * @returns {Array}
 */
function getTweets(category, opts = {}) {
  const db = getDB();
  if (!db) return [];

  const date         = opts.date || new Date().toISOString().split('T')[0];
  const minLikes     = opts.minLikes || 0;
  const minFollowers = opts.minFollowers || 0;
  const limit        = opts.limit || 100;

  let sql = `
    SELECT * FROM tweets
    WHERE category = ? AND fetched_date = ?
      AND likes >= ? AND author_followers >= ?
  `;
  const params = [category, date, minLikes, minFollowers];

  if (opts.token) {
    sql += ' AND token = ?';
    params.push(opts.token);
  }

  sql += ' ORDER BY score DESC, likes DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Get tweets across multiple days for trend analysis.
 */
function getTweetsHistory(category, days = 7, opts = {}) {
  const db = getDB();
  if (!db) return [];

  const cutoff = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

  let sql = `
    SELECT * FROM tweets
    WHERE category = ? AND fetched_date >= ?
  `;
  const params = [category, cutoff];

  if (opts.token) {
    sql += ' AND token = ?';
    params.push(opts.token);
  }

  sql += ' ORDER BY fetched_date DESC, score DESC LIMIT ?';
  params.push(opts.limit || 500);

  return db.prepare(sql).all(...params);
}

// ─── Author CRUD ─────────────────────────────────────────────────────────────

function upsertAuthors(authors) {
  const db = getDB();
  if (!db) return 0;

  const today = new Date().toISOString().split('T')[0];
  const now   = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tweet_authors
      (id, username, description, followers, following, tweet_count, verified, fetched_at, fetched_date)
    VALUES
      (@id, @username, @description, @followers, @following, @tweet_count, @verified, @fetched_at, @fetched_date)
  `);

  const insertMany = db.transaction((items) => {
    let count = 0;
    for (const u of items) {
      const pm = u.public_metrics || {};
      stmt.run({
        id:          u.id,
        username:    u.username || null,
        description: u.description || '',
        followers:   pm.followers_count || u.followers || 0,
        following:   pm.following_count || u.following || 0,
        tweet_count: pm.tweet_count || u.tweet_count || 0,
        verified:    u.verified ? 1 : 0,
        fetched_at:  now,
        fetched_date: today,
      });
      count++;
    }
    return count;
  });

  const count = insertMany(authors);
  log.info(`Upserted ${count} authors`);
  return count;
}

function getAuthors(opts = {}) {
  const db = getDB();
  if (!db) return [];

  const date         = opts.date || new Date().toISOString().split('T')[0];
  const minFollowers = opts.minFollowers || 0;
  const limit        = opts.limit || 100;

  return db.prepare(`
    SELECT * FROM tweet_authors
    WHERE fetched_date = ? AND followers >= ?
    ORDER BY followers DESC LIMIT ?
  `).all(date, minFollowers, limit);
}

// ─── Performance metrics ─────────────────────────────────────────────────────

function upsertMetrics(entries) {
  const db = getDB();
  if (!db) return 0;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tweet_metrics
      (tweet_id, type, content, posted_at, fetched_at, likes, replies, retweets, quotes, impressions, engagement_score, growth_score, tokens, window)
    VALUES
      (@tweet_id, @type, @content, @posted_at, @fetched_at, @likes, @replies, @retweets, @quotes, @impressions, @engagement_score, @growth_score, @tokens, @window)
  `);

  const insertMany = db.transaction((items) => {
    let count = 0;
    for (const e of items) {
      const m = e.metrics || e;
      stmt.run({
        tweet_id:         e.tweet_id || e.tweetId,
        type:             e.type || null,
        content:          e.content || '',
        posted_at:        e.posted_at || e.timestamp || e.postedAt || null,
        fetched_at:       e.fetched_at || new Date().toISOString(),
        likes:            m.likes || 0,
        replies:          m.replies || 0,
        retweets:         m.retweets || 0,
        quotes:           m.quotes || 0,
        impressions:      m.impressions || 0,
        engagement_score: m.engagement_score || 0,
        growth_score:     m.growth_value_score || m.growth_score || 0,
        tokens:           JSON.stringify(e.tokens || []),
        window:           e.window || null,
      });
      count++;
    }
    return count;
  });

  const count = insertMany(entries);
  log.info(`Upserted ${count} metric entries`);
  return count;
}

function getMetrics(opts = {}) {
  const db = getDB();
  if (!db) return [];

  const days  = opts.days || 30;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const limit = opts.limit || 500;

  return db.prepare(`
    SELECT * FROM tweet_metrics
    WHERE posted_at >= ?
    ORDER BY posted_at DESC LIMIT ?
  `).all(cutoff, limit);
}

function getLatestMetricsPerTweet(days = 30) {
  const db = getDB();
  if (!db) return [];

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // Get the most recent metric fetch for each tweet
  return db.prepare(`
    SELECT t1.* FROM tweet_metrics t1
    INNER JOIN (
      SELECT tweet_id, MAX(fetched_at) as max_fetched
      FROM tweet_metrics
      WHERE posted_at >= ?
      GROUP BY tweet_id
    ) t2 ON t1.tweet_id = t2.tweet_id AND t1.fetched_at = t2.max_fetched
    ORDER BY t1.posted_at DESC
  `).all(cutoff);
}

// ─── Search log ──────────────────────────────────────────────────────────────

function wasSearchedToday(category) {
  const db = getDB();
  if (!db) return false;

  const today = new Date().toISOString().split('T')[0];
  const row = db.prepare(
    'SELECT 1 FROM search_log WHERE category = ? AND search_date = ?'
  ).get(category, today);

  return !!row;
}

function logSearch(category, queryCount, tweetCount) {
  const db = getDB();
  if (!db) return;

  const today = new Date().toISOString().split('T')[0];
  const now   = new Date().toISOString();

  db.prepare(`
    INSERT OR REPLACE INTO search_log (category, search_date, fetched_at, query_count, tweet_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(category, today, now, queryCount, tweetCount);
}

// ─── Maintenance ─────────────────────────────────────────────────────────────

/**
 * Clean up old data to keep DB size manageable.
 * Keep tweets for 14 days, authors for 14 days, metrics for 90 days.
 */
function cleanup(tweetDays = 14, metricDays = 90) {
  const db = getDB();
  if (!db) return;

  const tweetCutoff  = new Date(Date.now() - tweetDays * 86400000).toISOString().split('T')[0];
  const metricCutoff = new Date(Date.now() - metricDays * 86400000).toISOString();

  const t1 = db.prepare('DELETE FROM tweets WHERE fetched_date < ?').run(tweetCutoff);
  const t2 = db.prepare('DELETE FROM tweet_authors WHERE fetched_date < ?').run(tweetCutoff);
  const t3 = db.prepare('DELETE FROM tweet_metrics WHERE posted_at < ?').run(metricCutoff);
  const t4 = db.prepare('DELETE FROM search_log WHERE search_date < ?').run(tweetCutoff);

  log.info(`Cleanup: removed ${t1.changes} tweets, ${t2.changes} authors, ${t3.changes} metrics, ${t4.changes} search logs`);
}

/**
 * Get DB stats for health check.
 */
function getStats() {
  const db = getDB();
  if (!db) return null;

  const today = new Date().toISOString().split('T')[0];

  return {
    totalTweets:    db.prepare('SELECT COUNT(*) as c FROM tweets').get().c,
    todayTweets:    db.prepare('SELECT COUNT(*) as c FROM tweets WHERE fetched_date = ?').get(today).c,
    totalAuthors:   db.prepare('SELECT COUNT(*) as c FROM tweet_authors').get().c,
    totalMetrics:   db.prepare('SELECT COUNT(*) as c FROM tweet_metrics').get().c,
    searchesToday:  db.prepare('SELECT COUNT(*) as c FROM search_log WHERE search_date = ?').get(today).c,
    dbSizeMB:       (() => {
      try {
        const fs = require('fs');
        const stats = fs.statSync(DB_PATH);
        return (stats.size / 1048576).toFixed(2);
      } catch { return '0'; }
    })(),
  };
}

// ─── Graceful close ──────────────────────────────────────────────────────────

function closeDB() {
  if (_db) {
    _db.close();
    _db = null;
    log.info('SQLite database closed');
  }
}

process.on('exit', closeDB);

module.exports = {
  getDB,
  // Tweets
  upsertTweets,
  getTweets,
  getTweetsHistory,
  // Authors
  upsertAuthors,
  getAuthors,
  // Metrics
  upsertMetrics,
  getMetrics,
  getLatestMetricsPerTweet,
  // Search log
  wasSearchedToday,
  logSearch,
  // Maintenance
  cleanup,
  getStats,
  closeDB,
};
