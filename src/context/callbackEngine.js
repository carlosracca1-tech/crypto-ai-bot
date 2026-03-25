'use strict';

/**
 * callbackEngine.js
 *
 * Tracks the last 72h of published tweets and identifies:
 * - Predictions made
 * - Key price levels mentioned
 * - Narratives introduced
 *
 * Then generates "callback tweets" that reference what happened:
 * "Yesterday we flagged X. Today it confirmed."
 * "That breakdown we mentioned → now playing out."
 *
 * Guarantees at least 1 callback tweet per day is injected into content.
 */

const fs     = require('fs');
const path   = require('path');
const OpenAI = require('openai');
const { createModuleLogger } = require('../utils/logger');
const { withRetry }          = require('../utils/retry');
const { config }             = require('../config');

const log = createModuleLogger('CallbackEngine');

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR        = path.join(process.cwd(), 'data');
const PIPELINE_LOG    = path.join(DATA_DIR, 'pipeline_runs.json');
const CALLBACK_LOG    = path.join(DATA_DIR, 'callback_log.json');

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadCallbackLog() {
  try {
    if (!fs.existsSync(CALLBACK_LOG)) return [];
    return JSON.parse(fs.readFileSync(CALLBACK_LOG, 'utf8'));
  } catch {
    return [];
  }
}

function saveCallbackLog(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CALLBACK_LOG, JSON.stringify(entries.slice(-200), null, 2));
}

// ─── Load recent published tweets ────────────────────────────────────────────

function getRecentTweets(windowHours = 72) {
  try {
    if (!fs.existsSync(PIPELINE_LOG)) return [];
    const data   = JSON.parse(fs.readFileSync(PIPELINE_LOG, 'utf8'));
    const runs   = Array.isArray(data) ? data : (data.runs || []);
    const cutoff = Date.now() - windowHours * 3600 * 1000;
    const tweets = [];

    for (const run of runs) {
      if (!run.publishedTweets) continue;
      for (const tweet of run.publishedTweets) {
        if (!tweet.content || !tweet.postedAt) continue;
        if (new Date(tweet.postedAt).getTime() > cutoff) {
          tweets.push(tweet);
        }
      }
    }

    return tweets;
  } catch (err) {
    log.warn(`Cannot load recent tweets: ${err.message}`);
    return [];
  }
}

// ─── Extract predictions & key mentions ──────────────────────────────────────

/**
 * Ask GPT to extract predictions, levels, and narratives from recent tweets.
 */
async function extractContextFromTweets(tweets) {
  if (!tweets.length) return null;

  const openai   = new OpenAI({ apiKey: config.openai.apiKey });
  const tweetList = tweets
    .slice(0, 15) // max 15 tweets for context
    .map((t, i) => `[${i + 1}] (${new Date(t.postedAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}): "${t.content}"`)
    .join('\n');

  const prompt = `Analyze these recent crypto tweets published by this account in the last 72 hours:

${tweetList}

Extract:
1. Any predictions made (directional calls, "if X then Y" scenarios)
2. Key price levels mentioned (support, resistance, breakout points)
3. Narratives or theses introduced (macro trends, token-specific stories)
4. Tokens that were the focus of analysis

Return JSON:
{
  "predictions": [
    { "tweet_index": 1, "prediction": "brief description", "token": "BTC", "direction": "bullish/bearish/neutral", "conditional": "if level holds..." }
  ],
  "key_levels": [
    { "token": "ETH", "level": "$3200", "type": "support/resistance", "mentioned_at": "tweet_index" }
  ],
  "narratives": [
    { "theme": "narrative description", "tokens": ["TAO", "FET"], "stance": "bullish/bearish/contrarian" }
  ],
  "focus_tokens": ["BTC", "TAO"]
}

Only include items that could be referenced in a follow-up tweet ("this is playing out / confirming / failed"). Skip generic observations.`;

  try {
    const result = await withRetry(async () => {
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 700,
      });
      return JSON.parse(completion.choices[0].message.content);
    }, { label: 'extractContext', retries: 2, delay: 2000 });

    return result;
  } catch (err) {
    log.error(`Context extraction failed: ${err.message}`);
    return null;
  }
}

// ─── Generate callback tweet ──────────────────────────────────────────────────

/**
 * Generate a callback tweet that references previous content + current market data.
 * @param {object} context - extracted predictions/levels/narratives
 * @param {object} fusionData - current market snapshot
 * @returns {string|null} tweet text
 */
async function generateCallbackTweet(context, fusionData) {
  if (!context) return null;

  const openai = new OpenAI({ apiKey: config.openai.apiKey });
  const tokens = fusionData?.tokens || [];

  // Pick the most relevant prior prediction to call back
  const topPrediction = context.predictions?.[0];
  const topLevel      = context.key_levels?.[0];
  const topNarrative  = context.narratives?.[0];

  // Current price context for referenced tokens
  const referencedTokens = [
    ...(context.focus_tokens || []),
    topPrediction?.token,
    topLevel?.token,
  ].filter(Boolean);

  const tokenContext = tokens
    .filter(t => referencedTokens.includes(t.symbol))
    .map(t => `${t.symbol}: $${t.currentPrice?.toFixed(2)} (${t.change24h >= 0 ? '+' : ''}${t.change24h?.toFixed(1)}% 24h)`)
    .join(', ') || 'market data loading...';

  const prompt = `Write ONE callback tweet that references something we called before — now either confirming, playing out, or contradicting.

WHAT WE SAID BEFORE:
${topPrediction ? `- Prediction: "${topPrediction.prediction}" on ${topPrediction.token || 'market'}` : ''}
${topLevel ? `- Key level: ${topLevel.token} at ${topLevel.level} (${topLevel.type})` : ''}
${topNarrative ? `- Narrative: "${topNarrative.theme}"` : ''}

CURRENT MARKET:
${tokenContext}

Write it as if you're a trader who called something earlier and is now acknowledging what happened — without being arrogant or self-congratulatory.

Style options (pick the most natural given what's happening):
- "That [level/move/thesis] we flagged → [what's happening now]"
- "Earlier we noted X. [Today / Since then] → [confirmation/failure]."
- "[Thing we said] playing out. [What it means next]."

RULES:
- 3 lines max, 278 chars max
- No emojis, no hashtags
- Be humble, not boastful — just accurate
- If the prediction is being confirmed: state it plainly and add the next implication
- If the prediction failed: acknowledge it briefly, pivot to what the new data shows

Return ONLY the tweet text.`;

  try {
    const result = await withRetry(async () => {
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.65,
        max_tokens: 200,
      });
      return completion.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    }, { label: 'generateCallback', retries: 2 });

    return result;
  } catch (err) {
    log.error(`Callback tweet generation failed: ${err.message}`);
    return null;
  }
}

// ─── Check if callback is needed today ───────────────────────────────────────

function callbackSentToday() {
  const log_entries = loadCallbackLog();
  const today       = new Date().toISOString().split('T')[0];
  return log_entries.some(e => e.date === today && e.sent);
}

function logCallbackSent(content) {
  const entries = loadCallbackLog();
  entries.unshift({
    date:      new Date().toISOString().split('T')[0],
    content,
    sent:      true,
    timestamp: new Date().toISOString(),
  });
  saveCallbackLog(entries);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a callback tweet for injection into the daily content plan.
 * Returns null if no recent content to callback or already sent one today.
 *
 * @param {object} fusionData - current market data from pipeline
 * @returns {Promise<string|null>}
 */
async function getCallbackTweet(fusionData) {
  // Only generate 1 callback per day
  if (callbackSentToday()) {
    log.info('Callback already sent today — skipping');
    return null;
  }

  const recentTweets = getRecentTweets(72);
  if (recentTweets.length < 3) {
    log.info(`Not enough recent tweets for callback (${recentTweets.length})`);
    return null;
  }

  log.info(`Generating callback from ${recentTweets.length} recent tweets...`);

  const context  = await extractContextFromTweets(recentTweets);
  if (!context || (!context.predictions?.length && !context.key_levels?.length && !context.narratives?.length)) {
    log.info('No callable context found in recent tweets');
    return null;
  }

  const callback = await generateCallbackTweet(context, fusionData);
  if (callback) {
    logCallbackSent(callback);
    log.info(`Callback tweet generated: ${callback.substring(0, 80)}...`);
  }

  return callback;
}

module.exports = {
  getCallbackTweet,
  extractContextFromTweets,
  generateCallbackTweet,
};
