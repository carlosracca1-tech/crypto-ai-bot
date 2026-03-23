'use strict';

/**
 * engagementEngine.js
 *
 * Upgraded engagement system with:
 * - Smart tweet prioritization (>50 likes in <1h, 5k–100k follower accounts)
 * - Insight-driven replies (not generic — adds data, contrarian view, or analysis)
 * - Multi-step interaction: like → reply → optional 2nd reply
 * - 20–30 max high-quality interactions/day
 * - Follow-like-reply sequence after new follows
 */

const fs     = require('fs');
const path   = require('path');
const OpenAI = require('openai');
const { TwitterApi } = require('twitter-api-v2');
const { createModuleLogger } = require('../utils/logger');
const { withRetry }          = require('../utils/retry');
const { sleep }              = require('../utils/retry');
const { config }             = require('../config');
const { sendErrorAlert }     = require('../alerts/emailAlerts');

const log = createModuleLogger('EngagementEngine');

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR        = path.join(process.cwd(), 'data');
const ENGAGEMENT_LOG  = path.join(DATA_DIR, 'engagement_log.json');

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_INTERACTIONS_PER_DAY = 25;
const MIN_FOLLOWER_COUNT        = 5000;
const MAX_FOLLOWER_COUNT        = 100000;
const MIN_LIKES_FOR_PRIORITY    = 50;   // >50 likes in <1h = priority target
const VELOCITY_WINDOW_MINUTES   = 60;
const DELAY_BETWEEN_MS          = 8000; // 8s between actions

// ─── Twitter clients ──────────────────────────────────────────────────────────

let _appClient   = null;
let _userClient  = null;

function getAppClient() {
  if (!_appClient) {
    _appClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN || config.twitter.bearerToken);
  }
  return _appClient.readOnly;
}

function getUserClient() {
  if (!_userClient) {
    _userClient = new TwitterApi({
      appKey:       config.twitter.appKey,
      appSecret:    config.twitter.appSecret,
      accessToken:  config.twitter.accessToken,
      accessSecret: config.twitter.accessSecret,
    });
  }
  return _userClient;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadEngagementLog() {
  try {
    if (!fs.existsSync(ENGAGEMENT_LOG)) return { daily: [], allTime: [] };
    return JSON.parse(fs.readFileSync(ENGAGEMENT_LOG, 'utf8'));
  } catch {
    return { daily: [], allTime: [] };
  }
}

function saveEngagementLog(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  data.allTime = (data.allTime || []).slice(-2000);
  fs.writeFileSync(ENGAGEMENT_LOG, JSON.stringify(data, null, 2));
}

function resetDailyEngagement(data) {
  const today = new Date().toISOString().split('T')[0];
  if (!data.lastReset || data.lastReset !== today) {
    data.daily     = [];
    data.lastReset = today;
  }
  return data;
}

function countTodayInteractions(data) {
  const today    = new Date().toISOString().split('T')[0];
  return (data.daily || []).filter(e => e.date === today).length;
}

function logInteraction(data, interaction) {
  const entry = {
    ...interaction,
    date:      new Date().toISOString().split('T')[0],
    timestamp: new Date().toISOString(),
  };
  data.daily.push(entry);
  data.allTime.push(entry);
  return data;
}

// ─── Tweet search + prioritization ───────────────────────────────────────────

const SEARCH_QUERIES = [
  '(BTC OR ETH OR SOL) crypto analysis -is:retweet lang:en',
  '(TAO OR RNDR OR FET OR AGIX) AI crypto -is:retweet lang:en',
  '(DeFi OR "on-chain" OR "layer 2") analysis -is:retweet lang:en',
  '(Bitcoin OR Ethereum) price technical -is:retweet lang:en',
];

/**
 * Fetch candidate tweets for engagement.
 * Returns tweets sorted by priority score.
 */
async function findPriorityTweets(maxPerQuery = 10) {
  const client    = getAppClient();
  const cutoff    = new Date(Date.now() - VELOCITY_WINDOW_MINUTES * 60 * 1000).toISOString();
  const allTweets = [];

  for (const query of SEARCH_QUERIES) {
    try {
      const results = await withRetry(async () => {
        return client.v2.search(query, {
          max_results: maxPerQuery,
          'tweet.fields':  'created_at,public_metrics,author_id',
          'user.fields':   'public_metrics,created_at',
          expansions:      'author_id',
          start_time:      cutoff,
        });
      }, { label: `engagementSearch`, retries: 2, delay: 3000 });

      const users = new Map();
      for (const user of (results.includes?.users || [])) {
        users.set(user.id, user);
      }

      for (const tweet of (results.data?.data || [])) {
        const author = users.get(tweet.author_id);
        if (!author) continue;

        const followerCount = author.public_metrics?.followers_count || 0;
        if (followerCount < MIN_FOLLOWER_COUNT || followerCount > MAX_FOLLOWER_COUNT) continue;

        const likes          = tweet.public_metrics?.like_count || 0;
        const tweetAgeMin    = (Date.now() - new Date(tweet.created_at).getTime()) / 60000;
        const velocityScore  = tweetAgeMin > 0 ? likes / tweetAgeMin : 0;
        const isHighVelocity = likes >= MIN_LIKES_FOR_PRIORITY && tweetAgeMin <= VELOCITY_WINDOW_MINUTES;

        const engagementRatio = followerCount > 0
          ? (tweet.public_metrics?.like_count + tweet.public_metrics?.reply_count * 2) / followerCount
          : 0;

        allTweets.push({
          id:             tweet.id,
          text:           tweet.text,
          author_id:      tweet.author_id,
          author_name:    author.name || '',
          author_handle:  author.username || '',
          followers:      followerCount,
          likes,
          replies:        tweet.public_metrics?.reply_count || 0,
          retweets:       tweet.public_metrics?.retweet_count || 0,
          created_at:     tweet.created_at,
          age_minutes:    tweetAgeMin,
          velocity_score: parseFloat(velocityScore.toFixed(3)),
          is_high_velocity: isHighVelocity,
          engagement_ratio: parseFloat(engagementRatio.toFixed(4)),
          // Priority score: high velocity + high engagement ratio
          priority: (isHighVelocity ? 10 : 0) + engagementRatio * 100 + velocityScore,
        });
      }

      await sleep(1000);
    } catch (err) {
      log.warn(`Search failed for query "${query.substring(0, 40)}...": ${err.message}`);
    }
  }

  // Deduplicate by tweet id and sort by priority
  const seen  = new Set();
  const dedup = allTweets.filter(t => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  return dedup.sort((a, b) => b.priority - a.priority);
}

// ─── Reply generation ─────────────────────────────────────────────────────────

/**
 * Generate a high-quality, insight-driven reply.
 * NOT generic — must add data, analysis, or a contrarian angle.
 */
async function generateInsightReply(tweet, fusionData = null) {
  const openai = new OpenAI({ apiKey: config.openai.apiKey });

  const marketCtx = fusionData?.tokens?.slice(0, 5)
    .map(t => `${t.symbol}: $${t.currentPrice?.toFixed(2)} (${t.change24h >= 0 ? '+' : ''}${t.change24h?.toFixed(1)}%)`)
    .join(', ') || '';

  const prompt = `You are engaging with this crypto tweet on Twitter/X:

"${tweet.text}"
— @${tweet.author_handle} (${tweet.followers.toLocaleString()} followers, ${tweet.likes} likes)

${marketCtx ? `Current market: ${marketCtx}` : ''}

Write ONE reply that:
1. Adds genuine value — a data point, an alternative angle, or a sharper framing of what they said
2. Does NOT agree/disagree generically ("good point", "totally agree", "interesting")
3. If you have contradicting data or a contrarian view → use it
4. If you can add a specific level, metric, or timeframe → add it
5. Is conversational but sharp — you're not lecturing, you're contributing

RULES:
- Max 200 chars (it's a reply, not a main tweet)
- No emojis, no hashtags
- No "Great tweet!" / "Exactly!" type openers
- Start with the substance, not a greeting
- Can be a question if it challenges an assumption

Return ONLY the reply text.`;

  try {
    const result = await withRetry(async () => {
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 150,
      });
      return completion.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    }, { label: 'generateReply', retries: 2 });

    return result;
  } catch (err) {
    log.error(`Reply generation failed: ${err.message}`);
    return null;
  }
}

// ─── Execute engagement ───────────────────────────────────────────────────────

/**
 * Execute the full engagement sequence for a tweet:
 * 1. Like the tweet
 * 2. Reply with insight
 * (Optional step 3: second reply if it gains traction — tracked but not auto-executed)
 */
async function executeSingleEngagement(tweet, fusionData, userClient) {
  const result = { tweet_id: tweet.id, liked: false, replied: false, reply_id: null, error: null };

  try {
    // Step 1: Like
    await withRetry(() => userClient.v2.like(
      (await userClient.v2.me()).data.id,
      tweet.id
    ), { label: 'like', retries: 2, delay: 2000 });
    result.liked = true;
    log.info(`Liked tweet ${tweet.id} by @${tweet.author_handle}`);
    await sleep(DELAY_BETWEEN_MS);

    // Step 2: Generate and post reply
    const replyText = await generateInsightReply(tweet, fusionData);
    if (!replyText) return result;

    const replyResult = await withRetry(() => userClient.v2.reply(replyText, tweet.id), {
      label: 'reply', retries: 2, delay: 2000,
    });
    result.replied  = true;
    result.reply_id = replyResult.data?.id;
    log.info(`Replied to ${tweet.id}: "${replyText.substring(0, 60)}..."`);

  } catch (err) {
    result.error = err.message;
    log.warn(`Engagement failed for ${tweet.id}: ${err.message}`);
  }

  return result;
}

// ─── Post-follow engagement ───────────────────────────────────────────────────

/**
 * After following an account, like 1-2 of their recent tweets.
 * Called by followEngine after a successful follow.
 */
async function engageAfterFollow(userId, userHandle) {
  try {
    const appClient  = getAppClient();
    const userClient = getUserClient();

    // Fetch 3 recent tweets from the followed account
    const recentTweets = await appClient.v2.userTimeline(userId, {
      max_results: 3,
      'tweet.fields': 'created_at,public_metrics',
    });

    const tweets = recentTweets.data?.data || [];
    if (!tweets.length) return;

    // Like the most recent relevant tweet
    const toEngage = tweets.slice(0, 2);
    const myId     = (await userClient.v2.me()).data.id;

    for (const tweet of toEngage) {
      try {
        await userClient.v2.like(myId, tweet.id);
        log.info(`Liked tweet from @${userHandle} after follow: ${tweet.id}`);
        await sleep(3000);
      } catch (err) {
        log.warn(`Failed to like tweet from @${userHandle}: ${err.message}`);
      }
    }
  } catch (err) {
    log.warn(`Post-follow engagement failed for @${userHandle}: ${err.message}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Main engagement session. Called 2x/day by scheduler.
 * Finds priority tweets and executes high-quality interactions.
 *
 * @param {object} fusionData - current market data for context
 * @param {object} opts
 */
async function runEngagementEngine(fusionData = null, opts = {}) {
  const { dryRun = config.content.dryRun, maxInteractions = MAX_INTERACTIONS_PER_DAY } = opts;

  log.info('Starting engagement engine session...');

  const logData    = resetDailyEngagement(loadEngagementLog());
  const todayCount = countTodayInteractions(logData);

  if (todayCount >= maxInteractions) {
    log.info(`Daily interaction limit reached (${todayCount}/${maxInteractions})`);
    return { interactions: 0, reason: 'daily_limit_reached' };
  }

  const remaining  = maxInteractions - todayCount;
  const candidates = await findPriorityTweets(15);

  if (!candidates.length) {
    log.info('No priority tweets found');
    return { interactions: 0, reason: 'no_candidates' };
  }

  log.info(`Found ${candidates.length} candidates. Running up to ${remaining} interactions.`);

  let interactions = 0;
  const userClient = dryRun ? null : getUserClient();

  for (const tweet of candidates.slice(0, remaining)) {
    // Check if already interacted
    const alreadyInteracted = logData.allTime.some(e => e.tweet_id === tweet.id);
    if (alreadyInteracted) continue;

    if (dryRun) {
      log.info(`[DRY RUN] Would engage with @${tweet.author_handle}: "${tweet.text.substring(0, 60)}..."`);
      interactions++;
      continue;
    }

    try {
      const result = await executeSingleEngagement(tweet, fusionData, userClient);

      logData.daily.push({
        tweet_id:    tweet.id,
        author:      tweet.author_handle,
        liked:       result.liked,
        replied:     result.replied,
        reply_id:    result.reply_id,
        priority:    tweet.priority,
        followers:   tweet.followers,
        date:        new Date().toISOString().split('T')[0],
        timestamp:   new Date().toISOString(),
      });
      logData.allTime.push(logData.daily[logData.daily.length - 1]);

      if (result.liked || result.replied) interactions++;
      await sleep(DELAY_BETWEEN_MS);

    } catch (err) {
      log.error(`Engagement error: ${err.message}`);
    }
  }

  saveEngagementLog(logData);
  log.info(`Engagement session complete: ${interactions} interactions`);
  return { interactions, total_today: todayCount + interactions };
}

module.exports = {
  runEngagementEngine,
  engageAfterFollow,
  findPriorityTweets,
  generateInsightReply,
};
