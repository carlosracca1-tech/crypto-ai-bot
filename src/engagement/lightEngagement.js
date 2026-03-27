'use strict';

/**
 * Light Engagement — Minimal API cost engagement module
 *
 * Does exactly 1 Twitter Search API call per session (2 sessions/day):
 *   1. Searches for AI+crypto tweets (1 API read, ~10 results)
 *   2. Sorts results by author follower count
 *   3. #1 most followers → quote tweet their latest tweet
 *   4. #2 most followers → reply to their latest tweet
 *
 * Total daily API cost: 2 reads + 2 writes = ultra-cheap
 */

const { TwitterApi } = require('twitter-api-v2');
const { config }            = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { generateReply }      = require('./replyGenerator');
const { postTweet }          = require('../twitter/twitterClient');
const { getValidClient }     = require('../utils/tokenManager');
const { sleep }              = require('../utils/retry');

const log = createModuleLogger('LightEngagement');

// Single consolidated query — covers all our niches in 1 API call
const SEARCH_QUERY = '("AI crypto" OR $TAO OR $FET OR $RNDR OR "decentralized AI") -is:retweet -is:reply lang:en';

/**
 * Run a single lightweight engagement session.
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun - If true, don't actually post
 * @returns {Promise<{quoteTweet: object|null, reply: object|null, searchCost: number}>}
 */
async function runLightEngagement({ dryRun = false } = {}) {
  log.info('═'.repeat(50));
  log.info('LIGHT ENGAGEMENT SESSION — 1 search, 1 quote, 1 reply');
  log.info('═'.repeat(50));

  // ── 1. Single search (1 API read) ─────────────────────────────────────────
  let tweets = [];
  try {
    tweets = await searchOnce();
  } catch (err) {
    log.error(`Search failed: ${err.message}`);
    // Mark 402 if applicable
    if (err.message?.includes('402')) {
      try {
        const { markSearchApiBlocked } = require('../narrative/twitterScraper');
        markSearchApiBlocked('402 in lightEngagement');
      } catch { /* ignore */ }
    }
    return { quoteTweet: null, reply: null, searchCost: 1 };
  }

  if (tweets.length < 2) {
    log.warn(`Only ${tweets.length} tweets found — need at least 2 for quote + reply`);
    return { quoteTweet: null, reply: null, searchCost: 1 };
  }

  // ── 2. Sort by follower count (descending) ────────────────────────────────
  tweets.sort((a, b) => (b.authorFollowers || 0) - (a.authorFollowers || 0));

  // Deduplicate by author (keep their best tweet)
  const seen = new Set();
  const unique = [];
  for (const t of tweets) {
    if (!t.authorId || seen.has(t.authorId)) continue;
    seen.add(t.authorId);
    unique.push(t);
  }

  if (unique.length < 2) {
    log.warn(`Only ${unique.length} unique authors — need at least 2`);
    return { quoteTweet: null, reply: null, searchCost: 1 };
  }

  const topAccount    = unique[0]; // Most followers → quote tweet
  const secondAccount = unique[1]; // 2nd most followers → reply

  log.info(`#1 @${topAccount.authorUsername} (${topAccount.authorFollowers} followers) → QUOTE TWEET`);
  log.info(`   Tweet: "${topAccount.text?.substring(0, 80)}..."`);
  log.info(`#2 @${secondAccount.authorUsername} (${secondAccount.authorFollowers} followers) → REPLY`);
  log.info(`   Tweet: "${secondAccount.text?.substring(0, 80)}..."`);

  // ── 3. Quote tweet (1 write) ──────────────────────────────────────────────
  let quoteTweetResult = null;
  try {
    const quoteText = await generateReply({
      text: topAccount.text,
      authorHandle: topAccount.authorUsername,
      authorFollowers: topAccount.authorFollowers,
      likes: topAccount.likes,
      retweets: topAccount.retweets,
    });

    if (quoteText) {
      log.info(`Quote tweet text: "${quoteText}"`);
      if (!dryRun) {
        quoteTweetResult = await postTweet(quoteText, null, null, topAccount.id);
        log.info(`✅ Quote tweet posted! ID: ${quoteTweetResult?.id}`);
      } else {
        log.info('[DRY RUN] Would post quote tweet');
        quoteTweetResult = { id: 'dryrun', text: quoteText };
      }
    }
  } catch (err) {
    log.error(`Quote tweet failed: ${err.message}`);
  }

  await sleep(5000); // Pause between actions

  // ── 4. Reply (1 write) ────────────────────────────────────────────────────
  let replyResult = null;
  try {
    const replyText = await generateReply({
      text: secondAccount.text,
      authorHandle: secondAccount.authorUsername,
      authorFollowers: secondAccount.authorFollowers,
      likes: secondAccount.likes,
      retweets: secondAccount.retweets,
    });

    if (replyText) {
      log.info(`Reply text: "${replyText}"`);
      if (!dryRun) {
        replyResult = await postTweet(replyText, null, secondAccount.id, null);
        log.info(`✅ Reply posted! ID: ${replyResult?.id}`);
      } else {
        log.info('[DRY RUN] Would post reply');
        replyResult = { id: 'dryrun', text: replyText };
      }
    }
  } catch (err) {
    log.error(`Reply failed: ${err.message}`);
  }

  log.info('═'.repeat(50));
  log.info(`Session complete | Quote: ${quoteTweetResult ? '✅' : '❌'} | Reply: ${replyResult ? '✅' : '❌'} | API reads: 1`);
  log.info('═'.repeat(50));

  return { quoteTweet: quoteTweetResult, reply: replyResult, searchCost: 1 };
}

/**
 * Single search using Bearer Token (app-only, cheapest read)
 * Returns normalized tweets with author follower counts
 */
async function searchOnce() {
  // Check if search is blocked (402)
  try {
    const { isSearchApiBlocked } = require('../narrative/twitterScraper');
    if (isSearchApiBlocked()) {
      log.warn('Search API blocked (402) — skipping');
      return [];
    }
  } catch { /* ignore */ }

  const bearerToken = config.twitter.bearerToken;
  if (!bearerToken) {
    log.warn('TWITTER_BEARER_TOKEN not configured — cannot search');
    return [];
  }

  const appClient = new TwitterApi(bearerToken);

  log.info(`Searching: "${SEARCH_QUERY.substring(0, 60)}..."`);

  const result = await appClient.v2.search(SEARCH_QUERY, {
    max_results: 10,          // Minimal — just 10 results
    'tweet.fields': ['public_metrics', 'created_at', 'author_id', 'entities'],
    'user.fields': ['username', 'public_metrics', 'verified'],
    expansions: ['author_id'],
    sort_order: 'relevancy',
  });

  const tweets = result.data?.data || [];
  const users  = result.data?.includes?.users || [];

  log.info(`Found ${tweets.length} tweets, ${users.length} users`);

  // Build user map
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  // Normalize and filter
  return tweets
    .map(tweet => {
      const author = userMap[tweet.author_id] || {};
      return {
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.author_id,
        authorUsername: author.username || 'unknown',
        authorFollowers: author.public_metrics?.followers_count || 0,
        authorVerified: author.verified || false,
        likes: tweet.public_metrics?.like_count || 0,
        retweets: tweet.public_metrics?.retweet_count || 0,
      };
    })
    .filter(t =>
      t.text.length > 30 &&                  // Minimum substance
      t.likes >= 2 &&                         // Some engagement
      t.authorFollowers >= 100 &&             // Not a brand new account
      !t.text.startsWith('RT ') &&            // No manual retweets
      !/^(gm|GM|ngmi|NGMI)/i.test(t.text)    // No low-effort tweets
    );
}

module.exports = { runLightEngagement };
