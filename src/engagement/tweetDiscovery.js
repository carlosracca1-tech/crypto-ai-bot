'use strict';

/**
 * Tweet Discovery Module
 *
 * Busca tweets relevantes sobre AI + crypto usando Twitter v2 Search API
 * con Bearer Token (app-only). Filtra y prioriza por calidad.
 */

const fs   = require('fs');
const path = require('path');
const { TwitterApi } = require('twitter-api-v2');
const { config }     = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { sleep }      = require('../utils/retry');
const { isSearchApiBlocked, markSearchApiBlocked } = require('../narrative/twitterScraper');
const { getCacheSection } = require('../storage/twitterCache');

const log = createModuleLogger('TweetDiscovery');

const DISCOVERY_CACHE_FILE = path.join(process.cwd(), 'data', 'discovery_cache.json');

// ─── Queries de búsqueda ────────────────────────────────────────────────────────

// Consolidated from 5 to 3 broader queries to save API reads (cached per day)
const SEARCH_QUERIES = [
  '(Bittensor OR TAO OR "AI agents" OR "AI crypto") -is:retweet lang:en',
  '(RNDR OR FET OR AGIX OR "Render Network" OR "SingularityNET") crypto -is:retweet lang:en',
  '("decentralized AI" OR "on-chain AI" OR "AI infrastructure") crypto -is:retweet lang:en',
];

// ─── Parámetros de calidad ──────────────────────────────────────────────────────

const MIN_FOLLOWERS     = 300;   // mínimo para que valga la pena responder
const MIN_LIKES         = 3;     // engagement mínimo del tweet
const MIN_TWEET_LENGTH  = 50;    // evitar tweets de 3 palabras
const MAX_TWEETS_TOTAL  = 40;    // tope de candidatos antes de rankear

// ─── Filtros de exclusión ───────────────────────────────────────────────────────

const SPAM_PATTERNS = [
  /giveaway/i,
  /airdrop/i,
  /\b(buy|sell)\b.*\b(now|today)\b/i,
  /100x/i,
  /guaranteed profit/i,
  /follow (me|us|back)/i,
  /DM (me|us)/i,
  /join (my|our|the) (telegram|discord)/i,
  /🚀{3,}/,       // más de 3 cohetes seguidos
  /pump/i,
];

function isSpam(text) {
  return SPAM_PATTERNS.some(p => p.test(text));
}

// ─── Puntuación de tweets ───────────────────────────────────────────────────────

/**
 * Puntúa un tweet candidato. Mayor puntaje = más prioridad para responder.
 */
function scoreTweet(tweet, author) {
  const followers = author?.public_metrics?.followers_count || 0;
  const likes     = tweet.public_metrics?.like_count        || 0;
  const retweets  = tweet.public_metrics?.retweet_count     || 0;
  const length    = tweet.text?.length                      || 0;

  // Puntaje base por engagement del tweet
  let score = Math.log1p(likes) * 2 + Math.log1p(retweets) * 3;

  // Bonus por tamaño de audiencia del autor (logarítmico para no dominar)
  score += Math.log1p(followers) * 0.5;

  // Bonus por longitud (tweets más elaborados → mejor para responder)
  if (length > 100) score += 1;
  if (length > 180) score += 1;

  // Penalizar tweets muy recientes (< 10 min): pueden no tener tracción aún
  const ageMinutes = (Date.now() - new Date(tweet.created_at).getTime()) / 60000;
  if (ageMinutes < 10) score *= 0.5;

  // Bonus leve a tweets de las últimas 4 horas (frescos pero con tracción)
  if (ageMinutes >= 10 && ageMinutes <= 240) score *= 1.2;

  return score;
}

// ─── Búsqueda principal ─────────────────────────────────────────────────────────

/**
 * Busca y devuelve tweets candidatos para responder, rankeados por calidad.
 * @param {string[]} excludeTweetIds - IDs de tweets ya respondidos hoy
 * @returns {Promise<Array>}
 */
async function discoverTweets(excludeTweetIds = []) {
  const bearerToken = config.twitter.bearerToken;

  if (!bearerToken) {
    log.warn('TWITTER_BEARER_TOKEN no configurado — discovery deshabilitado');
    return [];
  }

  // ── Check si la API está bloqueada (402) ──────────────────────────────────
  if (isSearchApiBlocked()) {
    log.info('Twitter Search API bloqueada (402) — discovery deshabilitado hasta reset');
    return [];
  }

  // ── Try unified daily cache first (populated by twitterCache.js) ─────────
  const unifiedData = getCacheSection('engagement');
  if (unifiedData && unifiedData.length > 0) {
    const excludeSet = new Set(excludeTweetIds);
    // Apply same quality filters + scoring to unified cache data
    const candidates = unifiedData
      .filter(t => !excludeSet.has(t.id))
      .filter(t => (t.authorFollowers || 0) >= MIN_FOLLOWERS)
      .filter(t => (t.likes || 0) >= MIN_LIKES)
      .filter(t => (t.text?.length || 0) >= MIN_TWEET_LENGTH)
      .filter(t => !isSpam(t.text))
      .filter(t => !t.text?.startsWith('@'))
      .map(t => ({
        id: t.id,
        text: t.text,
        authorId: t.author_id,
        authorHandle: t.authorUsername || 'unknown',
        authorFollowers: t.authorFollowers || 0,
        likes: t.likes || 0,
        retweets: t.retweets || 0,
        createdAt: t.created_at,
        score: Math.log1p(t.likes || 0) * 2 + Math.log1p(t.retweets || 0) * 3 +
               Math.log1p(t.authorFollowers || 0) * 0.5 +
               ((t.text?.length || 0) > 100 ? 1 : 0) + ((t.text?.length || 0) > 180 ? 1 : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_TWEETS_TOTAL);

    log.info(`Using unified daily cache (${candidates.length} engagement candidates)`);
    return candidates;
  }

  // ── Fallback: own day-cache (legacy, if unified cache wasn't populated) ───
  try {
    if (fs.existsSync(DISCOVERY_CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(DISCOVERY_CACHE_FILE, 'utf8'));
      const today = new Date().toISOString().split('T')[0];
      if (cache.date === today && cache.tweets?.length > 0) {
        const excludeSet = new Set(excludeTweetIds);
        const filtered = cache.tweets.filter(t => !excludeSet.has(t.id));
        log.info(`Using legacy discovery cache (${filtered.length} available from today)`);
        return filtered;
      }
    }
  } catch {}

  const client       = new TwitterApi(bearerToken);
  const excludeSet   = new Set(excludeTweetIds);
  const allCandidates = [];
  const seenIds      = new Set();

  for (const query of SEARCH_QUERIES) {
    try {
      log.info(`Buscando: "${query.substring(0, 60)}..."`);

      const results = await client.v2.search(query, {
        max_results: 15,
        'tweet.fields': ['created_at', 'public_metrics', 'author_id', 'conversation_id', 'text'],
        'user.fields':  ['username', 'public_metrics', 'verified'],
        'expansions':   ['author_id'],
        sort_order:     'relevancy',
      });

      if (!results.data?.data?.length) {
        log.info('  → 0 resultados');
        await sleep(1000);
        continue;
      }

      // Indexar autores por ID
      const usersMap = {};
      if (results.data.includes?.users) {
        for (const u of results.data.includes.users) {
          usersMap[u.id] = u;
        }
      }

      let queryAdded = 0;
      for (const tweet of results.data.data) {
        // Deduplicar
        if (seenIds.has(tweet.id)) continue;
        seenIds.add(tweet.id);

        // Ya respondido
        if (excludeSet.has(tweet.id)) continue;

        const author = usersMap[tweet.author_id];

        // Filtros de calidad
        const followers = author?.public_metrics?.followers_count || 0;
        const likes     = tweet.public_metrics?.like_count        || 0;

        if (followers < MIN_FOLLOWERS)    continue;
        if (likes     < MIN_LIKES)        continue;
        if ((tweet.text?.length || 0) < MIN_TWEET_LENGTH) continue;
        if (isSpam(tweet.text))           continue;

        // Es respuesta a otro tweet (evitar responder a respuestas — mejor responder al original)
        if (tweet.text?.startsWith('@'))  continue;

        allCandidates.push({
          id:        tweet.id,
          text:      tweet.text,
          authorId:  tweet.author_id,
          authorHandle: author?.username || 'unknown',
          authorFollowers: followers,
          likes,
          retweets:  tweet.public_metrics?.retweet_count || 0,
          createdAt: tweet.created_at,
          score:     scoreTweet(tweet, author),
        });
        queryAdded++;
      }

      log.info(`  → ${queryAdded} candidatos aceptados`);
      await sleep(1200); // respeto rate limits
    } catch (err) {
      if (err.message?.includes('402') || err.code === 402) {
        log.warn('Twitter Search API requiere plan de pago (402). Bloqueando por 24h.');
        markSearchApiBlocked('402 en tweetDiscovery');
        break; // No seguir intentando
      } else if (err.code === 429) {
        log.warn('Rate limit hit en búsqueda — esperando 60s');
        await sleep(60000);
      } else {
        log.error(`Error en query "${query.substring(0, 40)}": ${err.message}`);
      }
    }
  }

  // Rankear por score descendente y limitar
  const ranked = allCandidates
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TWEETS_TOTAL);

  // Save to day-cache
  if (ranked.length > 0) {
    try {
      fs.mkdirSync(path.dirname(DISCOVERY_CACHE_FILE), { recursive: true });
      fs.writeFileSync(DISCOVERY_CACHE_FILE, JSON.stringify({
        date: new Date().toISOString().split('T')[0],
        savedAt: new Date().toISOString(),
        tweets: ranked,
      }, null, 2));
      log.info(`Saved ${ranked.length} discovery tweets to day-cache`);
    } catch (err) {
      log.warn(`Error saving discovery cache: ${err.message}`);
    }
  }

  log.info(`Discovery completado: ${ranked.length} candidatos rankeados`);
  return ranked;
}

module.exports = { discoverTweets };
