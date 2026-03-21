'use strict';

const { TwitterApi } = require('twitter-api-v2');
const fs = require('fs-extra');
const path = require('path');
const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { withRetry, sleep } = require('../utils/retry');

const log = createModuleLogger('TwitterClient');

// ─── Cliente OAuth 1.0a (posting) ─────────────────────────────────────────────

let _postingClient = null;

function getPostingClient() {
  if (_postingClient) return _postingClient;

  if (!config.twitter.appKey || !config.twitter.appSecret) {
    throw new Error('Twitter app credentials (APP_KEY / APP_SECRET) no configurados');
  }
  if (!config.twitter.accessToken || !config.twitter.accessSecret) {
    throw new Error('Twitter access tokens no configurados');
  }

  _postingClient = new TwitterApi({
    appKey: config.twitter.appKey,
    appSecret: config.twitter.appSecret,
    accessToken: config.twitter.accessToken,
    accessSecret: config.twitter.accessSecret,
  });

  return _postingClient;
}

// ─── Verificación de credenciales ─────────────────────────────────────────────

/**
 * Verifica que las credenciales son válidas
 * @returns {Promise<object>} - Datos del usuario autenticado
 */
async function verifyCredentials() {
  const client = getPostingClient();

  const me = await withRetry(
    async () => {
      const result = await client.v2.me({
        'user.fields': ['username', 'name', 'public_metrics'],
      });
      return result.data;
    },
    { label: 'verifyCredentials', ...config.retry }
  );

  log.info(`Autenticado como @${me.username} (${me.public_metrics?.followers_count} followers)`);
  return me;
}

// ─── Upload de media ───────────────────────────────────────────────────────────

/**
 * Sube una imagen a Twitter y devuelve el media_id
 * @param {string} imagePath - Ruta local de la imagen
 * @returns {Promise<string>} - media_id_string
 */
async function uploadMedia(imagePath) {
  if (!imagePath || !await fs.pathExists(imagePath)) {
    log.warn(`Imagen no encontrada: ${imagePath}`);
    return null;
  }

  log.info(`Subiendo imagen: ${path.basename(imagePath)}...`);

  const client = getPostingClient();
  const v1Client = client.v1;

  const mediaId = await withRetry(
    async () => {
      const imageBuffer = await fs.readFile(imagePath);
      const id = await v1Client.uploadMedia(imageBuffer, { mimeType: 'image/png' });
      return id;
    },
    { label: 'uploadMedia', ...config.retry }
  );

  log.info(`Imagen subida. media_id: ${mediaId}`);
  return mediaId;
}

// ─── Publicación de tweets ─────────────────────────────────────────────────────

/**
 * Publica un tweet individual
 * @param {string} text
 * @param {string|null} imagePath - Ruta de imagen opcional
 * @param {string|null} replyToId - ID de tweet al que responder (para threads)
 * @returns {Promise<object>} - Tweet publicado
 */
async function postTweet(text, imagePath = null, replyToId = null) {
  if (config.content.dryRun) {
    log.info(`[DRY RUN] Tweet que se publicaría:\n${text}`);
    if (imagePath) log.info(`[DRY RUN] Con imagen: ${imagePath}`);
    return { id: `dryrun_${Date.now()}`, text };
  }

  const client = getPostingClient();

  // Upload de imagen si existe
  let mediaId = null;
  if (imagePath) {
    try {
      mediaId = await uploadMedia(imagePath);
    } catch (err) {
      log.error(`Error subiendo imagen: ${err.message}. Publicando sin imagen.`);
    }
  }

  // Construir payload
  const payload = { text };
  if (mediaId) payload.media = { media_ids: [mediaId] };
  if (replyToId) payload.reply = { in_reply_to_tweet_id: replyToId };

  const result = await withRetry(
    async () => {
      const response = await client.v2.tweet(payload);
      return response.data;
    },
    { label: 'postTweet', ...config.retry }
  );

  log.info(`Tweet publicado. ID: ${result.id}`);
  return result;
}

// ─── Publicación de threads ────────────────────────────────────────────────────

/**
 * Publica un thread de tweets en secuencia
 * @param {Array<{tweet: string, type: string}>} threadTweets
 * @param {Array<string|null>} imagePaths - Una imagen por tweet (o null)
 * @returns {Promise<Array>}
 */
async function postThread(threadTweets, imagePaths = []) {
  if (!threadTweets || threadTweets.length === 0) {
    log.warn('Thread vacío, nada que publicar');
    return [];
  }

  log.info(`Publicando thread de ${threadTweets.length} tweets...`);

  const publishedTweets = [];
  let lastTweetId = null;

  for (let i = 0; i < threadTweets.length; i++) {
    const tweetText = threadTweets[i].tweet || threadTweets[i];
    const imagePath = imagePaths[i] || null;

    // Añadir numeración al thread
    const numberedText = threadTweets.length > 1
      ? `${i + 1}/${threadTweets.length} ${tweetText}`
      : tweetText;

    // Truncar si excede límite (con espacio para numeración)
    const finalText = numberedText.length > 275
      ? numberedText.slice(0, 272) + '...'
      : numberedText;

    try {
      const published = await postTweet(finalText, imagePath, lastTweetId);
      publishedTweets.push({ ...published, position: i + 1, type: threadTweets[i].type });
      lastTweetId = published.id;

      log.info(`Tweet ${i + 1}/${threadTweets.length} publicado. ID: ${published.id}`);

      // Esperar entre tweets del thread para evitar rate limiting
      if (i < threadTweets.length - 1) {
        await sleep(3000);
      }
    } catch (err) {
      log.error(`Error publicando tweet ${i + 1} del thread: ${err.message}`);
      // Continuar con el resto del thread
    }
  }

  log.info(`Thread publicado: ${publishedTweets.length}/${threadTweets.length} tweets exitosos`);
  return publishedTweets;
}

// ─── Scheduler de publicación ──────────────────────────────────────────────────

/**
 * Publica tweets con espaciado temporal
 * @param {Array} tweets - Tweets generados
 * @param {object} fusionData - Para obtener imágenes
 * @returns {Promise<Array>}
 */
async function publishScheduledTweets(tweets, fusionData = null) {
  const { selectAndGenerateImage } = require('../images/imageGenerator');

  log.info(`Iniciando publicación de ${tweets.length} tweets...`);
  const publishedResults = [];

  for (let i = 0; i < tweets.length; i++) {
    const tweet = tweets[i];

    if (tweet.posted) {
      log.info(`Tweet ${tweet.id} ya publicado, saltando...`);
      continue;
    }

    try {
      // Generar imagen apropiada
      let imagePath = null;
      if (fusionData) {
        try {
          imagePath = await selectAndGenerateImage(tweet, fusionData);
        } catch (imgErr) {
          log.warn(`No se pudo generar imagen para tweet ${tweet.type}: ${imgErr.message}`);
        }
      }

      // Publicar
      const published = await postTweet(tweet.content, imagePath);

      tweet.posted = true;
      tweet.postId = published.id;
      tweet.postedAt = new Date().toISOString();
      tweet.imagePath = imagePath;

      publishedResults.push({ tweet, published, imagePath });

      log.info(`Tweet ${i + 1}/${tweets.length} publicado. ID: ${published.id}`);

      // Espaciado entre tweets (excepto el último)
      if (i < tweets.length - 1) {
        const delayMinutes = 30; // 30 minutos entre tweets
        log.info(`Esperando ${delayMinutes} minutos antes del siguiente tweet...`);
        await sleep(delayMinutes * 60 * 1000);
      }

    } catch (err) {
      log.error(`Error publicando tweet ${tweet.id}: ${err.message}`);
      tweet.error = err.message;
      publishedResults.push({ tweet, error: err.message });
    }
  }

  log.info(`Publicación completada: ${publishedResults.filter(r => !r.error).length}/${tweets.length} exitosos`);
  return publishedResults;
}

/**
 * Publica tweets sin espera (para uso en pipeline ya temporizado)
 * @param {Array} tweets
 * @param {object} fusionData
 */
async function publishTweetsImmediate(tweets, fusionData = null) {
  const { selectAndGenerateImage } = require('../images/imageGenerator');
  const results = [];

  for (const tweet of tweets) {
    if (tweet.posted) continue;

    try {
      let imagePath = null;
      if (fusionData) {
        imagePath = await selectAndGenerateImage(tweet, fusionData).catch(() => null);
      }

      const published = await postTweet(tweet.content, imagePath);
      tweet.posted = true;
      tweet.postId = published.id;
      tweet.postedAt = new Date().toISOString();

      results.push({ success: true, tweetId: published.id, type: tweet.type });
      await sleep(5000); // pequeño delay entre tweets
    } catch (err) {
      log.error(`Error: ${err.message}`);
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
  publishScheduledTweets,
  publishTweetsImmediate,
};
