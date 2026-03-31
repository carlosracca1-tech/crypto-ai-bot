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
const { getValidClient, forceRefresh } = require('../utils/tokenManager');
const { getCacheSection }    = require('../storage/twitterCache');
const { updateTweetStatus }  = require('../storage/dataStore');

// Lazy import: chartGenerator usa canvas (módulo nativo) que puede no estar
// disponible en todos los entornos. Se carga solo cuando se necesita generar un chart.
let _generateChartForToken = null;
function getChartGenerator() {
  if (_generateChartForToken === null) {
    try {
      _generateChartForToken = require('../charts/chartGenerator').generateChartForToken;
    } catch (e) {
      _generateChartForToken = false; // marcamos como no disponible
      log.warn(`Chart generator no disponible: ${e.message}`);
    }
  }
  return _generateChartForToken || null;
}

const log = createModuleLogger('TwitterClient');

// ─── Cached user ID (avoid repeated v2.me() calls — each one is a Read) ────
let _cachedUserId = null;

async function getCachedUserId(client) {
  if (_cachedUserId) return _cachedUserId;
  // COST CONTROL: Skip v2.me() API call when reads disabled
  if (config.twitter.readsDisabled) {
    // Use hardcoded user ID from the access token (format: userId-randomChars)
    const tokenUserId = config.twitter.accessToken?.split('-')[0];
    if (tokenUserId) {
      _cachedUserId = tokenUserId;
      log.info(`User ID from token (no API call): ${_cachedUserId}`);
      return _cachedUserId;
    }
  }
  const me = await client.v2.me();
  _cachedUserId = me.data.id;
  log.info(`User ID cached: ${_cachedUserId}`);
  return _cachedUserId;
}

// ─── OAuth 2.0 posting client ──────────────────────────────────────────────────

async function getPostingClient() {
  return await getValidClient();
}

// ─── Verificación de identidad ────────────────────────────────────────────────

async function verifyCredentials() {
  // COST CONTROL: Skip v2.me() when reads disabled
  if (config.twitter.readsDisabled) {
    log.info('⚡ READS_DISABLED — skipping verifyCredentials');
    return { id: config.twitter.accessToken?.split('-')[0], username: 'TheProtocoMind' };
  }
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

  // Intento 1: OAuth 1.0a (método estándar para media upload v1.1)
  try {
    const oauthClient = new TwitterApi({ appKey, appSecret, accessToken, accessSecret });
    const mediaId = await oauthClient.v1.uploadMedia(filePath);
    log.info(`Media subida correctamente. media_id: ${mediaId}`);
    return String(mediaId);
  } catch (err) {
    const is401 = err.code === 401 || err.message?.includes('401');
    if (is401) {
      log.error(`uploadMedia OAuth 1.0a 401 — tokens probablemente revocados. Regenerar TWITTER_ACCESS_TOKEN y TWITTER_ACCESS_SECRET en el Developer Portal.`);
    } else {
      log.error(`Error subiendo media: ${err.message}`);
    }

    // Intento 2: OAuth 2.0 user context como fallback
    if (is401) {
      try {
        log.info('uploadMedia: intentando fallback con OAuth 2.0 client...');
        const oauth2Client = await getValidClient();
        const mediaId = await oauth2Client.v1.uploadMedia(filePath);
        log.info(`Media subida via OAuth 2.0 fallback. media_id: ${mediaId}`);
        return String(mediaId);
      } catch (fallbackErr) {
        log.error(`uploadMedia OAuth 2.0 fallback también falló: ${fallbackErr.message}`);
      }
    }

    return null;
  }
}

// ─── Publicación de un tweet ──────────────────────────────────────────────────

/**
 * Publica un tweet de texto (con media y/o quote opcionales).
 * @param {string}      text          - Contenido del tweet (máx 280 chars)
 * @param {string|null} mediaId       - media_id de imagen ya subida (o null)
 * @param {string|null} replyToId     - tweet ID al que responder (o null)
 * @param {string|null} quoteTweetId  - tweet ID a citar como quote tweet (o null)
 */
async function postTweet(text, mediaId = null, replyToId = null, quoteTweetId = null) {
  if (config.content.dryRun) {
    log.info(`[DRY RUN] Tweet (${text.length} chars)${mediaId ? ' [+imagen]' : ''}${quoteTweetId ? ` [quote: ${quoteTweetId}]` : ''}:\n${text}`);
    return { id: `dryrun_${Date.now()}`, text };
  }

  // Garantizar límite de 260 chars (Twitter weighted: emojis like ⚡ count as 2)
  if (text.length > 260) {
    text = text.substring(0, 258).replace(/\s+\S*$/, '').trim();
    log.warn(`Tweet truncado a ${text.length} chars`);
  }

  let client = await getPostingClient();

  const payload = { text };
  if (replyToId)    payload.reply          = { in_reply_to_tweet_id: replyToId };
  if (mediaId)      payload.media          = { media_ids: [String(mediaId)] };
  if (quoteTweetId) payload.quote_tweet_id = String(quoteTweetId);

  log.info(`postTweet payload: textLen=${text.length} mediaId=${mediaId || 'none'} quoteTweetId=${quoteTweetId || 'none'}`);

  // Primera tentativa
  let result;
  try {
    const response = await client.v2.tweet(payload);
    result = response.data;
  } catch (firstErr) {
    const errCode = String(firstErr.code || firstErr.statusCode || '');
    const is401 = errCode === '401' || firstErr.message?.includes('401');
    // 400 puede indicar token expirado/inválido en OAuth2 (Twitter devuelve 400 en vez de 401 a veces)
    const is400 = errCode === '400' || firstErr.message?.includes('status code 400');
    const isAuthLike = is401 || is400;

    if (isAuthLike) {
      // Token expirado/invalido — force refresh y reintentar una vez
      log.warn(`postTweet ${errCode || '400/401'} detectado — forzando refresh de OAuth 2.0 token...`);
      try {
        client = await forceRefresh();
        log.info('Token refrescado exitosamente. Reintentando tweet...');
        const retryResponse = await client.v2.tweet(payload);
        result = retryResponse.data;
      } catch (refreshErr) {
        const detail = refreshErr.data ? JSON.stringify(refreshErr.data) : '';
        log.error(`postTweet falló incluso después de refresh: ${refreshErr.message}${detail ? ` | ${detail}` : ''}`);
        throw refreshErr;
      }
    } else {
      const detail = firstErr.data ? JSON.stringify(firstErr.data) : (firstErr.errors ? JSON.stringify(firstErr.errors) : '');
      log.error(`Twitter API error ${firstErr.code || '?'}: ${firstErr.message}${detail ? ` | ${detail}` : ''}`);
      throw firstErr;
    }
  }

  log.info(`✅ Tweet publicado! ID: ${result.id} | ${text.length} chars${mediaId ? ' | con imagen' : ''}${quoteTweetId ? ' | quote tweet' : ''}`);
  return result;
}

// ─── Búsqueda de tweets para quote (Bearer Token — app-only) ──────────────────

/**
 * Busca tweets recientes sobre un token para usar como quote tweet.
 * Usa Bearer Token (app-only, sin costo de escritura).
 *
 * @param {string} symbol - Token symbol (e.g., 'TAO', 'FET')
 * @returns {Promise<Array>} Lista de tweet objects con id, text, public_metrics
 */
async function searchTweetsForToken(symbol) {
  // COST CONTROL: Skip search when reads disabled
  if (config.twitter.readsDisabled) {
    log.info(`⚡ READS_DISABLED — skipping searchTweetsForToken($${symbol})`);
    return [];
  }
  // ── Try unified daily cache first (0 API calls) ───────────────────────
  const cachedQuotes = getCacheSection('quoteByToken');
  if (cachedQuotes && cachedQuotes[symbol.toUpperCase()]) {
    const cached = cachedQuotes[symbol.toUpperCase()];
    const filtered = cached
      .filter(t =>
        (t.likes || 0) >= 3 &&
        (t.text?.length || 0) > 40 &&
        !t.text?.startsWith('RT ') &&
        !/^(gm|GM|ngmi|NGMI)/i.test((t.text || '').trim())
      )
      .slice(0, 8);

    log.info(`searchTweetsForToken($${symbol}): ${filtered.length} from unified cache`);
    return filtered;
  }

  // ── Fallback: live API search ─────────────────────────────────────────
  const bearerToken = config.twitter.bearerToken;
  if (!bearerToken) {
    log.warn('searchTweetsForToken: TWITTER_BEARER_TOKEN no configurado');
    return [];
  }

  try {
    const { isSearchApiBlocked } = require('../narrative/twitterScraper');
    if (isSearchApiBlocked()) {
      log.info('Twitter Search API bloqueada (402) — skip searchTweetsForToken');
      return [];
    }
  } catch { /* ignore */ }

  try {
    const appClient = new TwitterApi(bearerToken);
    const query = `$${symbol} -is:retweet -is:reply lang:en`;

    const result = await appClient.v2.search(query, {
      max_results: 15,
      'tweet.fields': ['public_metrics', 'created_at', 'author_id', 'entities'],
      sort_order: 'relevancy',
    });

    const tweets = result.data?.data || [];

    const filtered = tweets
      .filter(t =>
        (t.public_metrics?.like_count || 0) >= 3 &&
        t.text.length > 40 &&
        !t.text.startsWith('RT ') &&
        !/^(gm|GM|ngmi|NGMI)/i.test(t.text.trim())
      )
      .slice(0, 8);

    log.info(`searchTweetsForToken($${symbol}): ${filtered.length} candidatos válidos de ${tweets.length} (live)`);
    return filtered;
  } catch (err) {
    if (err.message?.includes('402')) {
      try {
        const { markSearchApiBlocked } = require('../narrative/twitterScraper');
        markSearchApiBlocked('402 en searchTweetsForToken');
      } catch { /* ignore */ }
    }
    log.warn(`searchTweetsForToken error: ${err.message}`);
    return [];
  }
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

    // ── Generar y subir chart — Opción 2: 2 tipos de tweet con chart ──────
    // technical_analysis (Slot 3): chart de setup técnico del token focus
    // market_insight (Slot 1, mañana): chart del token líder del día
    const CHART_TYPES = new Set(['technical_analysis', 'market_insight']);
    if (CHART_TYPES.has(tweet.type) && fusionData) {
      try {
        log.info(`Generando chart para tweet ${tweet.type}...`);
        const chartGen = getChartGenerator();
        if (!chartGen) throw new Error('Chart generator no disponible');
        const chartPath = await chartGen(fusionData);

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

    // ── Publicar tweet (soporta quote tweets — Opción 3) ───────────────────
    try {
      const published = await postTweet(tweet.content, mediaId, null, tweet.quoteTweetId || null);
      tweet.posted      = true;
      tweet.postId      = published.id;
      tweet.postedAt    = new Date().toISOString();
      tweet.hasChart    = !!mediaId;
      tweet.isQuoteTweet = !!tweet.quoteTweetId;

      // ── Persistir estado "posted" a disco (fix: antes se perdía en memoria) ──
      try {
        await updateTweetStatus(tweet.id, {
          posted:   true,
          postId:   published.id,
          postedAt: tweet.postedAt,
          hasChart: !!mediaId,
        });
      } catch (persistErr) {
        log.warn(`No se pudo persistir estado de tweet ${tweet.id}: ${persistErr.message}`);
      }

      results.push({
        success: true,
        tweetId: published.id,
        type: tweet.type,
        content: tweet.content,
        postedAt: tweet.postedAt,
        hasChart: !!mediaId,
        isQuoteTweet: !!tweet.quoteTweetId,
      });
      await sleep(5000);
    } catch (err) {
      // Log full Twitter API error detail (code, data, errors array)
      const detail = err.data ? JSON.stringify(err.data) : (err.errors ? JSON.stringify(err.errors) : '');
      log.error(`Error publicando tweet (${tweet.type}): ${err.message}${detail ? ` | detail: ${detail}` : ''} | textLen: ${tweet.content?.length}`);
      results.push({ success: false, error: err.message, type: tweet.type });
    }
  }

  return results;
}

// ─── Retweet ──────────────────────────────────────────────────────────────────

/**
 * Retweetea un tweet existente.
 * @param {string} tweetId - ID del tweet a retweetear
 * @returns {Promise<object|null>} Resultado del retweet o null si falla
 */
async function retweet(tweetId) {
  if (!tweetId) {
    log.warn('retweet: tweetId no proporcionado');
    return null;
  }

  if (config.content.dryRun) {
    log.info(`[DRY RUN] Retweet de: ${tweetId}`);
    return { retweeted: true, tweetId, dryRun: true };
  }

  const client = await getPostingClient();

  try {
    const userId = await getCachedUserId(client);

    const result = await withRetry(
      async () => {
        const response = await client.v2.retweet(userId, tweetId);
        return response.data;
      },
      { label: `retweet(${tweetId})`, ...config.retry }
    );

    log.info(`✅ Retweeteado! Tweet ID: ${tweetId}`);
    return result;
  } catch (err) {
    const detail = err.data ? JSON.stringify(err.data) : '';
    log.error(`Error retweeteando ${tweetId}: ${err.message}${detail ? ` | ${detail}` : ''}`);
    return null;
  }
}

/**
 * Deshace un retweet.
 * @param {string} tweetId - ID del tweet original
 * @returns {Promise<object|null>}
 */
async function unretweet(tweetId) {
  if (!tweetId) return null;

  const client = await getPostingClient();

  try {
    const userId = await getCachedUserId(client);

    const result = await client.v2.unretweet(userId, tweetId);
    log.info(`Unretweet exitoso: ${tweetId}`);
    return result.data;
  } catch (err) {
    log.error(`Error en unretweet ${tweetId}: ${err.message}`);
    return null;
  }
}

/**
 * Busca tweets de alta calidad sobre AI crypto para retweetear.
 * Reutiliza searchTweetsForToken pero con criterios más estrictos.
 * @param {object} opts
 * @param {number} opts.minLikes - Mínimo de likes (default: 10)
 * @param {number} opts.maxResults - Máximo resultados (default: 5)
 * @returns {Promise<Array>} Lista de tweets candidatos para RT
 */
async function findRetweetCandidates(opts = {}) {
  // COST CONTROL: Skip search when reads disabled
  if (config.twitter.readsDisabled) {
    log.info('⚡ READS_DISABLED — skipping findRetweetCandidates');
    return [];
  }

  const { minLikes = 10, maxResults = 5 } = opts;

  // ── Try unified daily cache first (0 API calls) ───────────────────────
  const cachedRT = getCacheSection('retweet');
  if (cachedRT && cachedRT.length > 0) {
    const filtered = cachedRT
      .filter(t => (t.likes || 0) >= minLikes)
      .filter(t => (t.authorFollowers || 0) >= 500)
      .filter(t => (t.text?.length || 0) >= 50)
      .map(t => ({
        id: t.id,
        text: t.text,
        authorUsername: t.authorUsername,
        authorFollowers: t.authorFollowers || 0,
        likes: t.likes || 0,
        retweets: t.retweets || 0,
        score: (t.likes || 0) * 2 + (t.retweets || 0) * 3 + Math.log1p(t.authorFollowers || 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    log.info(`findRetweetCandidates: ${filtered.length} from unified cache`);
    return filtered;
  }

  // ── Fallback: live API search ─────────────────────────────────────────
  let isBlocked = false;
  try {
    const { isSearchApiBlocked } = require('../narrative/twitterScraper');
    isBlocked = isSearchApiBlocked();
  } catch { /* ignore */ }

  if (isBlocked) {
    log.info('Twitter Search API bloqueada — skip findRetweetCandidates');
    return [];
  }

  const bearerToken = config.twitter.bearerToken;
  if (!bearerToken) return [];

  const queries = [
    '"AI crypto" OR "decentralized AI" -is:retweet lang:en',
    '$TAO OR $FET OR $RNDR OR $NEAR -is:retweet lang:en',
  ];

  const allCandidates = [];

  try {
    const appClient = new TwitterApi(bearerToken);

    for (const query of queries) {
      try {
        const result = await appClient.v2.search(query, {
          max_results: 15,
          'tweet.fields': ['public_metrics', 'created_at', 'author_id'],
          'user.fields':  ['username', 'public_metrics', 'verified'],
          expansions:     ['author_id'],
          sort_order:     'relevancy',
        });

        const tweets = result.data?.data || [];
        const users  = result.data?.includes?.users || [];
        const userMap = Object.fromEntries(users.map(u => [u.id, u]));

        for (const t of tweets) {
          const likes     = t.public_metrics?.like_count || 0;
          const retweets  = t.public_metrics?.retweet_count || 0;
          const author    = userMap[t.author_id] || {};
          const followers = author.public_metrics?.followers_count || 0;

          if (likes < minLikes) continue;
          if (followers < 500) continue;
          if (t.text.length < 50) continue;

          allCandidates.push({
            id: t.id,
            text: t.text,
            authorUsername: author.username,
            authorFollowers: followers,
            likes,
            retweets,
            score: likes * 2 + retweets * 3 + Math.log1p(followers),
          });
        }

        await sleep(2000);
      } catch (err) {
        if (err.message?.includes('402')) {
          const { markSearchApiBlocked } = require('../narrative/twitterScraper');
          markSearchApiBlocked('402 en findRetweetCandidates');
          break;
        }
        log.warn(`Error buscando RT candidates: ${err.message}`);
      }
    }
  } catch (err) {
    log.error(`findRetweetCandidates error: ${err.message}`);
  }

  return allCandidates
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

module.exports = {
  verifyCredentials,
  uploadMedia,
  postTweet,
  postThread,
  publishTweetsImmediate,
  searchTweetsForToken,
  retweet,
  unretweet,
  findRetweetCandidates,
  getCachedUserId,
  // Legacy alias
  publishScheduledTweets: publishTweetsImmediate,
};
