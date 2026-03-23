'use strict';

/**
 * liveAdjuster.js
 *
 * Runs every 2–3 hours. Monitors tweet velocity in real-time:
 * - Overperforming tweets → generate follow-up within 2h
 * - Underperforming tweets → flag for next cycle and adjust immediately
 *
 * This is the continuous learning loop — not daily, but intra-day.
 */

const fs     = require('fs');
const path   = require('path');
const OpenAI = require('openai');
const { createModuleLogger } = require('../utils/logger');
const { withRetry }          = require('../utils/retry');
const { config }             = require('../config');
const { loadPerformanceLog, fetchTweetMetrics: _fetchMetrics, computeEngagementScore } = require('./performanceEngine');
const { sendErrorAlert } = require('../alerts/emailAlerts');

const log = createModuleLogger('LiveAdjuster');

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR         = path.join(process.cwd(), 'data');
const LIVE_STATE_FILE  = path.join(DATA_DIR, 'live_adjuster_state.json');
const PIPELINE_LOG     = path.join(DATA_DIR, 'pipeline_runs.json');

// Thresholds
const OVERPERFORM_MULTIPLIER  = 2.5;  // 2.5× avg score = overperforming
const UNDERPERFORM_MULTIPLIER = 0.3;  // < 30% of avg score = underperforming
const VELOCITY_WINDOW_HOURS   = 2;    // Check tweets posted in last 2h

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (!fs.existsSync(LIVE_STATE_FILE)) return { followups_sent: [], last_run: null, adjustments: [] };
    return JSON.parse(fs.readFileSync(LIVE_STATE_FILE, 'utf8'));
  } catch {
    return { followups_sent: [], last_run: null, adjustments: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Keep last 200 followup records
  state.followups_sent = (state.followups_sent || []).slice(-200);
  state.adjustments    = (state.adjustments    || []).slice(-100);
  fs.writeFileSync(LIVE_STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Get fresh tweet metrics for very recent tweets ──────────────────────────

async function getRecentTweetMetrics(windowHours = VELOCITY_WINDOW_HOURS) {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN || config.twitter.bearerToken;
  if (!bearerToken) return [];

  const cutoff  = Date.now() - windowHours * 3600 * 1000;
  const perfLog = loadPerformanceLog();
  const recent  = perfLog.filter(e => new Date(e.timestamp).getTime() > cutoff);

  if (!recent.length) return [];

  // Re-fetch fresh metrics for these tweets
  const ids     = recent.map(e => e.tweet_id);
  const url     = `https://api.twitter.com/2/tweets?ids=${ids.join(',')}&tweet.fields=public_metrics,created_at`;

  try {
    const data = await withRetry(async () => {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${bearerToken}` } });
      if (!res.ok) throw new Error(`Twitter API ${res.status}`);
      return res.json();
    }, { label: 'liveMetrics', retries: 2, delay: 2000 });

    const refreshed = [];
    for (const tweet of (data.data || [])) {
      const base  = recent.find(e => e.tweet_id === tweet.id);
      const m     = tweet.public_metrics || {};
      const score = computeEngagementScore({
        likes: m.like_count, replies: m.reply_count, retweets: m.retweet_count, impressions: m.impression_count,
      });
      refreshed.push({ ...base, fresh_score: score, fresh_metrics: m });
    }
    return refreshed;
  } catch (err) {
    log.warn(`Live metrics fetch failed: ${err.message}`);
    return [];
  }
}

// ─── Velocity analysis ────────────────────────────────────────────────────────

function analyzeVelocity(recentTweets, allEntries) {
  if (!recentTweets.length) return { overperforming: [], underperforming: [] };

  const avgScore = allEntries.length
    ? allEntries.reduce((s, e) => s + e.metrics.engagement_score, 0) / allEntries.length
    : 5;

  const overperforming  = recentTweets.filter(t => t.fresh_score >= avgScore * OVERPERFORM_MULTIPLIER);
  const underperforming = recentTweets.filter(t => t.fresh_score <= avgScore * UNDERPERFORM_MULTIPLIER);

  return { overperforming, underperforming, avg_score: avgScore };
}

// ─── Follow-up generation ─────────────────────────────────────────────────────

/**
 * Generate a follow-up tweet to capitalize on a viral tweet's momentum.
 * Reuses the same token/narrative, adds new angle.
 */
async function generateFollowUp(originalTweet) {
  const openai = new OpenAI({ apiKey: config.openai.apiKey });

  const prompt = `A tweet just went viral in crypto Twitter. Here it is:

"${originalTweet.content}"

Engagement score: ${originalTweet.fresh_score.toFixed(1)} (${originalTweet.fresh_metrics?.like_count || 0} likes, ${originalTweet.fresh_metrics?.retweet_count || 0} RTs)

Your job: write ONE follow-up tweet that:
1. References the original without repeating it (use "Earlier we flagged..." or "That move we mentioned..." or just reference it implicitly)
2. Adds NEW information, data, or a deeper angle on the same theme/token
3. Creates a callback loop — rewards people who saw the first tweet
4. Is self-contained — newcomers can understand it without the original

RULES:
- 3 lines max, 278 chars max
- No emojis, no hashtags
- Don't say "as mentioned" or "as I said" — be implicit
- The hook must be stronger than the original or confirm what was signaled

Return ONLY the tweet text.`;

  try {
    const result = await withRetry(async () => {
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 200,
      });
      return completion.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    }, { label: 'generateFollowUp', retries: 2 });

    return result;
  } catch (err) {
    log.error(`Follow-up generation failed: ${err.message}`);
    return null;
  }
}

// ─── Underperformance analysis ────────────────────────────────────────────────

/**
 * Analyze why a tweet underperformed and return a hint for the next generation.
 */
async function analyzeUnderperformance(tweet) {
  const openai = new OpenAI({ apiKey: config.openai.apiKey });

  const prompt = `This crypto tweet severely underperformed (very low engagement):

"${tweet.content}"

Type: ${tweet.type} | Score: ${tweet.fresh_score?.toFixed(1) || 0}

In 2-3 sentences, diagnose why this likely failed to engage. Be specific:
- Was the hook too weak?
- Was it too generic / predictable?
- Did it over-explain?
- Was the topic irrelevant?
- Was the structure wrong?

Then give ONE concrete instruction to improve the NEXT tweet of this type.

Format:
{
  "diagnosis": "...",
  "next_tweet_hint": "..."
}`;

  try {
    const result = await withRetry(async () => {
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 200,
      });
      return JSON.parse(completion.choices[0].message.content);
    }, { label: 'analyzeUnderperformance', retries: 2 });

    return result;
  } catch {
    return { diagnosis: 'Analysis unavailable', next_tweet_hint: 'Be more specific and lead with tension' };
  }
}

// ─── Publish follow-up tweet ──────────────────────────────────────────────────

async function publishFollowUp(content) {
  try {
    const { TwitterApi } = require('twitter-api-v2');
    const client = new TwitterApi({
      appKey:       config.twitter.appKey,
      appSecret:    config.twitter.appSecret,
      accessToken:  config.twitter.accessToken,
      accessSecret: config.twitter.accessSecret,
    });
    const result = await client.v2.tweet(content);
    return result.data?.id || null;
  } catch (err) {
    log.error(`Failed to publish follow-up: ${err.message}`);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Main live adjustment cycle.
 * Called every 2-3 hours by the scheduler.
 */
async function runLiveAdjuster() {
  log.info('Running live adjuster...');
  const state   = loadState();
  const allLogs = loadPerformanceLog();

  try {
    // 1. Get fresh metrics for tweets posted in the last 2h
    const recentTweets = await getRecentTweetMetrics(VELOCITY_WINDOW_HOURS);
    if (!recentTweets.length) {
      log.info('No recent tweets to analyze');
      state.last_run = new Date().toISOString();
      saveState(state);
      return { followups: [], adjustments: [] };
    }

    // 2. Analyze velocity
    const { overperforming, underperforming, avg_score } = analyzeVelocity(recentTweets, allLogs);

    log.info(`Velocity check: ${overperforming.length} overperforming, ${underperforming.length} underperforming (avg: ${avg_score.toFixed(1)})`);

    const followups    = [];
    const adjustments  = [];

    // 3. Handle overperforming tweets
    for (const tweet of overperforming) {
      // Skip if we already sent a follow-up for this tweet
      if (state.followups_sent.includes(tweet.tweet_id)) continue;

      log.info(`Overperforming tweet detected: ${tweet.tweet_id} (score: ${tweet.fresh_score.toFixed(1)})`);

      const followupContent = await generateFollowUp(tweet);
      if (!followupContent) continue;

      // Publish in production; skip in dry-run
      let publishedId = null;
      if (!config.content.dryRun) {
        publishedId = await publishFollowUp(followupContent);
      } else {
        log.info(`[DRY RUN] Follow-up would be: ${followupContent}`);
      }

      followups.push({
        original_id:    tweet.tweet_id,
        original_score: tweet.fresh_score,
        followup_content: followupContent,
        published_id:   publishedId,
        published_at:   new Date().toISOString(),
      });

      state.followups_sent.push(tweet.tweet_id);
    }

    // 4. Handle underperforming tweets
    for (const tweet of underperforming) {
      log.warn(`Underperforming tweet: ${tweet.tweet_id} (score: ${tweet.fresh_score?.toFixed(1) || 0})`);

      const analysis = await analyzeUnderperformance(tweet);

      adjustments.push({
        tweet_id:  tweet.tweet_id,
        type:      tweet.type,
        score:     tweet.fresh_score,
        diagnosis: analysis.diagnosis,
        hint:      analysis.next_tweet_hint,
        timestamp: new Date().toISOString(),
      });

      log.info(`Underperformance diagnosis for ${tweet.type}: ${analysis.diagnosis}`);
    }

    // 5. Persist state
    state.last_run    = new Date().toISOString();
    state.adjustments = [...(state.adjustments || []), ...adjustments].slice(-100);
    saveState(state);

    return { followups, adjustments, stats: { overperforming: overperforming.length, underperforming: underperforming.length } };

  } catch (err) {
    log.error(`Live adjuster failed: ${err.message}`);
    setImmediate(() => sendErrorAlert({ module: 'LiveAdjuster', error: err.message, stack: err.stack }).catch(() => {}));
    return { followups: [], adjustments: [], error: err.message };
  }
}

/**
 * Get the latest adjustment hints for a specific tweet type.
 * Used by contentGenerator to improve next tweet.
 */
function getLatestHintForType(tweetType) {
  const state = loadState();
  const hints = (state.adjustments || [])
    .filter(a => a.type === tweetType)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return hints[0]?.hint || null;
}

module.exports = {
  runLiveAdjuster,
  getLatestHintForType,
};
