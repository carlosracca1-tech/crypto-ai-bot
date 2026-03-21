'use strict';

/**
 * Twitter Client — OAuth 2.0 (posting) + OAuth 1.0a (media upload)
 *
 * - Tweets: OAuth 2.0 user context via getValidClient() / refreshOAuth2Token()
 * - Media:  OAuth 1.0a via v1.uploadMedia() (Twitter API v1.1)
 *
 * IMPORTANT: never do `new TwitterApi(accessToken)` for posting — that creates
 * a Bearer / app-only client that can't write tweets on behalf of a user.
 */

const fs  = require('fs');
const { TwitterApi } = require('twitter-api-v2');

const { config }          = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { withRetry, sleep }   = require('../utils/retry');
const { getValidClient }     = require('../utils/tokenManager');
const { generateChartForToken } = require('../charts/chartGenerator');

const log = createModuleLogger('TwitterClient');

// ─── OAuth 2.0 posting client ──────────────────────────────────────────────────

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

// ─── Media upload (OAuth 1.0a — Twitter v1.1) ─────────────────────────────────

/**
 * Sube una imagen a Twitter usando OAuth 1.0a y devuelve el media_id.
 * @param {string} filePath - Ruta absoluta al archivo PNG/JPG
 * @returns {Promise<string|null>} media_id o null si falla
 */
async function uploadMedia(filePath) {
  if (!filePath) return null;

  if (!fs.existsSync(filePath)) {
    log.warn(`uploadMedia: archivo no encontrado: ${filePath}`);
    return null;
  }

  const { appKey, appSecret, accessToken, accessSecret } = config.twitter;

  if (!appKey || !appSecret || !accessToken || !accessSecret) {
    log.warn('uploadMedia: credenciales OAuth 1.0a no configuradas (APP_KEY/SECRET/ACCESS_TOKEN/SECRET)');
    return null;
  }

  try {
    const oauthClient = new TwitterApi({ appKey, appSecret, accessToken, accessSecret });
    const mediaId = await oauthClient.v1.uploadMedia(filePath);
    log.info(`Media subida correctamente. media_id: ${mediaId}`);
    return String(mediaId);
  } catch (err) {
    log.error(`Error subiendo media: ${err.message}`);
    return null;
  }
}

// ─── Publicación de un tweet ──────────────────────────────────────────────────

/**
 * Publica un tweet de texto (con media opcional).
 * @param {string}      text       - Contenido del tweet (máx 280 chars)
 * @param {string|null} mediaId    - media_id de imagen ya subida (o null)
 * @param {string|null} replyToId  - tweet ID al que responder
 */
async function postTweet(text, mediaId = null, replyToId = null) {
  if (config.content.dryRun) {
    log.info(`[DRY RUN] Tweet (${text.length} chars)${mediaId ? ' [+imagen]' : ''}:\n${text}`);
    return { id: `dryrun_${Date.now()}`, text };
  }

  // Garantizar límite de 280 chars
  if (text.length > 280) {
    text = text.substring(0, 278).replace(/\s+\S*$/, '').trim();
    log.warn(`Tweet truncado a ${text.length} chars`);
  }

  const client = await getPostingClient();

  const payload = { text };
  if (replyToId) payload.reply  = { in_reply_to_tweet_id: replyToId };
  if (mediaId)   payload.media  = { media_ids: [String(mediaId)] };

  const result = await withRetry(
    async () => {
      const response = await client.v2.tweet(payload);
      return response.data;
    },
    { label: 'postTweet', ...config.retry }
  );

  log.info(`✅ Tweet publicado! ID: ${result.id} | ${text.length} chars${mediaId ? ' | con imagen' : ''}`);
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

// ─── Publicación inmediata ─────────────────────────────────────────────────────

/**
 * Publica una lista de tweets. Para tweets de tipo `technical_analysis`,
 * genera automáticamente un gráfico y lo adjunta.
 *
 * @param {Array}       tweets     - Lista de tweet objects del pipeline
 * @param {object|null} fusionData - Datos del pipeline (para generar chart)
 */
async function publishTweetsImmediate(tweets, fusionData = null) {
  const results = [];

  for (const tweet of tweets) {
    if (tweet.posted) continue;

    let mediaId = null;

    // ── Generar y subir chart para tweet técnico ────────────────────────────
    if (tweet.type === 'technical_analysis' && fusionData) {
      try {
        log.info('Generando chart para tweet técnico...');
        const chartPath = await generateChartForToken(fusionData);

        if (chartPath) {
          log.info(`Chart generado: ${chartPath}. Subiendo a Twitter...`);
          mediaId = await uploadMedia(chartPath);
          if (mediaId) {
            log.info(`Chart subido correctamente. media_id: ${mediaId}`);
          } else {
            log.warn('Chart no se pudo subir — tweet sin imagen');
          }
        }
      } catch (chartErr) {
        log.error(`Error generando chart: ${chartErr.message}`);
      }
    }

    // ── Publicar tweet ──────────────────────────────────────────────────────
    try {
      const published = await postTweet(tweet.content, mediaId);
      tweet.posted   = true;
      tweet.postId   = published.id;
      tweet.postedAt = new Date().toISOString();
      tweet.hasChart = !!mediaId;

      results.push({ success: true, tweetId: published.id, type: tweet.type, hasChart: !!mediaId });
      await sleep(5000);
    } catch (err) {
      log.error(`Error publicando tweet (${tweet.type}): ${err.message}`);
      results.push({ success: false, error: err.message, type: tweet.type });
    }
  }

  return results;
}

module.exports = {
  verifyCredentials,
  uploadMedia,
  postTweet,
  postThread,
  publishTweetsImmediate,
  // Legacy alias
  publishScheduledTweets: publishTweetsImmediate,
};
