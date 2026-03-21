'use strict';

/**
 * Twitter Client — OAuth 2.0 User Context
 *
 * Usa OAuth 2.0 (Client ID + Refresh Token) para postear tweets.
 * El access token se refresca automáticamente antes de cada run.
 * No soporta media upload (requiere API v1.1 que no está en free tier con OAuth 2.0).
 */

const { config }     = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { withRetry, sleep }   = require('../utils/retry');
const { getValidClient }     = require('../utils/tokenManager');

const log = createModuleLogger('TwitterClient');

// ─── Cliente OAuth 2.0 ────────────────────────────────────────────────────────

/**
 * Devuelve el cliente OAuth 2.0 user context correcto.
 * NUNCA usar new TwitterApi(tokenString) — eso crea un cliente app-only (Bearer).
 * El client que devuelve refreshOAuth2Token() SÍ es user context.
 */
async function getPostingClient() {
  return await getValidClient();
}

// ─── Verificación de identidad ────────────────────────────────────────────────

async function verifyCredentials() {
  const client = await getPostingClient();
  const me = await client.v2.me({ 'user.fields': ['username', 'public_metrics'] });
  log.info(`Autenticado como @${me.data.username}`);
  return me.data;
}

// ─── Publicación de un tweet ──────────────────────────────────────────────────

/**
 * Publica un tweet de texto.
 * @param {string} text        - Contenido del tweet (máx 280 chars)
 * @param {string|null} _img   - Ignorado (media upload no disponible con OAuth 2.0 free)
 * @param {string|null} replyToId
 */
async function postTweet(text, _img = null, replyToId = null) {
  if (config.content.dryRun) {
    log.info(`[DRY RUN] Tweet (${text.length} chars):\n${text}`);
    return { id: `dryrun_${Date.now()}`, text };
  }

  // Garantizar límite de 280 chars
  if (text.length > 280) {
    text = text.substring(0, 278).replace(/\s+\S*$/, '').trim();
    log.warn(`Tweet truncado a ${text.length} chars`);
  }

  const client = await getPostingClient();

  const payload = { text };
  if (replyToId) payload.reply = { in_reply_to_tweet_id: replyToId };

  const result = await withRetry(
    async () => {
      const response = await client.v2.tweet(payload);
      return response.data;
    },
    { label: 'postTweet', ...config.retry }
  );

  log.info(`✅ Tweet publicado! ID: ${result.id} | ${text.length} chars`);
  return result;
}

// ─── Publicación de thread ────────────────────────────────────────────────────

async function postThread(threadTweets) {
  if (!threadTweets || threadTweets.length === 0) {
    log.warn('Thread vacío');
    return [];
  }

  log.info(`Publicando thread de ${threadTweets.length} tweets...`);
  const published = [];
  let lastId = null;

  for (let i = 0; i < threadTweets.length; i++) {
    const rawText = threadTweets[i].tweet || threadTweets[i];
    const prefix  = threadTweets.length > 1 ? `${i + 1}/${threadTweets.length} ` : '';
    let text = `${prefix}${rawText}`;

    if (text.length > 278) {
      text = text.substring(0, 278).replace(/\s+\S*$/, '').trim();
    }

    try {
      const p = await postTweet(text, null, lastId);
      published.push({ ...p, position: i + 1 });
      lastId = p.id;
      if (i < threadTweets.length - 1) await sleep(3000);
    } catch (err) {
      log.error(`Error en tweet ${i + 1} del thread: ${err.message}`);
    }
  }

  log.info(`Thread: ${published.length}/${threadTweets.length} publicados`);
  return published;
}

// ─── Publicación inmediata de lista de tweets ─────────────────────────────────

async function publishTweetsImmediate(tweets) {
  const results = [];

  for (const tweet of tweets) {
    if (tweet.posted) continue;

    try {
      const published = await postTweet(tweet.content);
      tweet.posted   = true;
      tweet.postId   = published.id;
      tweet.postedAt = new Date().toISOString();

      results.push({ success: true, tweetId: published.id, type: tweet.type });
      await sleep(5000);
    } catch (err) {
      log.error(`Error publicando tweet: ${err.message}`);
      results.push({ success: false, error: err.message, type: tweet.type });
    }
  }

  return results;
}

// ─── Upload de media (no disponible) ─────────────────────────────────────────

async function uploadMedia() {
  log.warn('uploadMedia: no disponible con OAuth 2.0 free tier (requiere API v1.1)');
  return null;
}

module.exports = {
  verifyCredentials,
  uploadMedia,
  postTweet,
  postThread,
  publishTweetsImmediate,
  // Legacy aliases
  publishScheduledTweets: publishTweetsImmediate,
};
