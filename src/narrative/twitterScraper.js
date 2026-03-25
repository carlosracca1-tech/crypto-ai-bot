'use strict';

const fs   = require('fs');
const path = require('path');
const { TwitterApi } = require('twitter-api-v2');
const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { withRetry, sleep } = require('../utils/retry');
const { uniqueBy } = require('../utils/helpers');

const log = createModuleLogger('TwitterScraper');

// ─── Paths de cache ──────────────────────────────────────────────────────────

const DATA_DIR         = path.join(process.cwd(), 'data');
const API_STATUS_FILE  = path.join(DATA_DIR, 'twitter_api_status.json');
const NARRATIVE_CACHE  = path.join(DATA_DIR, 'narrative_cache.json');

// ─── Cache de estado de API (evita reintentar 402 por 24h) ───────────────────

function loadApiStatus() {
  try {
    if (!fs.existsSync(API_STATUS_FILE)) return null;
    return JSON.parse(fs.readFileSync(API_STATUS_FILE, 'utf8'));
  } catch { return null; }
}

function saveApiStatus(status) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(API_STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) { log.warn(`No se pudo guardar API status: ${e.message}`); }
}

/**
 * Verifica si la Twitter Search API está bloqueada (402) y no debemos reintentar.
 * El bloqueo dura 24h desde la última detección.
 */
function isSearchApiBlocked() {
  const status = loadApiStatus();
  if (!status || !status.blocked) return false;

  const blockedAt = new Date(status.blockedAt).getTime();
  const ttlMs     = (status.ttlHours || 24) * 60 * 60 * 1000;
  const expired   = Date.now() > blockedAt + ttlMs;

  if (expired) {
    log.info('Bloqueo de Twitter Search API expirado — reintentando en próximo ciclo');
    saveApiStatus({ blocked: false });
    return false;
  }

  const hoursLeft = ((blockedAt + ttlMs - Date.now()) / 3600000).toFixed(1);
  log.info(`Twitter Search API bloqueada (402). Reintento en ${hoursLeft}h. Usando fallback.`);
  return true;
}

function markSearchApiBlocked(reason = '402 Payment Required') {
  log.warn(`Marcando Twitter Search API como bloqueada: ${reason}`);
  saveApiStatus({
    blocked:   true,
    blockedAt: new Date().toISOString(),
    reason,
    ttlHours:  24,
  });
}

// ─── Cache de narrativas del día (evita repetir búsquedas 6x/día) ──────────

function loadNarrativeCache() {
  try {
    if (!fs.existsSync(NARRATIVE_CACHE)) return null;
    const data = JSON.parse(fs.readFileSync(NARRATIVE_CACHE, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    if (data.date === today && data.tweets && data.tweets.length > 0) {
      return data;
    }
    return null; // cache de otro día
  } catch { return null; }
}

function saveNarrativeCache(result) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(NARRATIVE_CACHE, JSON.stringify({
      date:    new Date().toISOString().split('T')[0],
      savedAt: new Date().toISOString(),
      ...result,
    }, null, 2));
  } catch (e) { log.warn(`No se pudo guardar narrative cache: ${e.message}`); }
}

// ─── Cliente Twitter ───────────────────────────────────────────────────────────

let _client = null;

function getTwitterClient() {
  if (_client) return _client;

  if (!config.twitter.bearerToken) {
    throw new Error('TWITTER_BEARER_TOKEN no configurado. La detección de narrativas requiere acceso a Twitter API.');
  }

  _client = new TwitterApi(config.twitter.bearerToken);
  return _client;
}

// ─── Búsqueda de tweets ────────────────────────────────────────────────────────

/**
 * Busca tweets recientes por query
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<Array>}
 */
async function searchRecentTweets(query, maxResults = 50) {
  const client = getTwitterClient();

  const lookbackHours = config.narrative.lookbackHours;
  const startTime = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  const result = await withRetry(
    async () => {
      const response = await client.v2.search(query, {
        max_results: Math.min(maxResults, 100),
        start_time: startTime,
        'tweet.fields': [
          'created_at',
          'public_metrics',
          'author_id',
          'lang',
          'entities',
          'context_annotations',
        ],
        'user.fields': ['username', 'public_metrics', 'verified'],
        expansions: ['author_id'],
        sort_order: 'relevancy',
      });
      return response;
    },
    { label: `searchTweets(${query})`, ...config.retry }
  );

  const tweets = result.data?.data || [];
  const users = result.data?.includes?.users || [];

  // Mapa de usuarios para lookup rápido
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  return tweets.map(tweet => normalizeTweet(tweet, userMap));
}

/**
 * Normaliza un tweet a estructura interna
 */
function normalizeTweet(tweet, userMap) {
  const author = userMap[tweet.author_id] || {};
  return {
    id: tweet.id,
    text: tweet.text,
    authorId: tweet.author_id,
    authorUsername: author.username,
    authorFollowers: author.public_metrics?.followers_count || 0,
    authorVerified: author.verified || false,
    createdAt: tweet.created_at,
    lang: tweet.lang,
    likes: tweet.public_metrics?.like_count || 0,
    retweets: tweet.public_metrics?.retweet_count || 0,
    replies: tweet.public_metrics?.reply_count || 0,
    quotes: tweet.public_metrics?.quote_count || 0,
    engagement: (
      (tweet.public_metrics?.like_count || 0) +
      (tweet.public_metrics?.retweet_count || 0) * 2 +
      (tweet.public_metrics?.reply_count || 0)
    ),
    hashtags: tweet.entities?.hashtags?.map(h => h.tag.toLowerCase()) || [],
    mentions: tweet.entities?.mentions?.map(m => m.username.toLowerCase()) || [],
    urls: tweet.entities?.urls?.map(u => u.expanded_url) || [],
  };
}

// ─── Queries consolidadas (de 13 a 6) ──────────────────────────────────────────

const CONSOLIDATED_QUERIES = [
  // 1. Mega-query general AI + crypto
  '("AI crypto" OR "crypto AI" OR "decentralized AI" OR "on-chain AI") -is:retweet lang:en',
  // 2. Compute & infrastructure
  '("Render Network" OR RNDR OR "decentralized compute" OR "AI infrastructure" OR "GPU network") crypto -is:retweet lang:en',
  // 3. AI agents & autonomy
  '("AI agents" OR "autonomous agents" OR "AI agent" OR "AGI blockchain") crypto -is:retweet lang:en',
  // 4. Bittensor ecosystem
  '(Bittensor OR $TAO OR "decentralized ML") -is:retweet lang:en',
  // 5. Fetch.ai + SingularityNET ecosystem
  '("Fetch.ai" OR $FET OR SingularityNET OR AGIX OR "AI marketplace") crypto -is:retweet lang:en',
  // 6. Data & ML markets
  '("AI data marketplace" OR "machine learning blockchain" OR "data economy") crypto -is:retweet lang:en',
];

// ─── Búsqueda multi-query ──────────────────────────────────────────────────────

/**
 * Ejecuta búsquedas para todas las queries de narrative.
 * USA CACHE: solo busca 1x por día. Las siguientes 5 ejecuciones usan cache.
 * @param {object} opts
 * @param {boolean} opts.forceRefresh - Ignorar cache y buscar de nuevo
 * @returns {Promise<object>} - { tweets: [], byQuery: {} }
 */
async function fetchNarrativeTweets(opts = {}) {
  // ── Check cache primero (evita repetir búsquedas 6x/día) ─────────────────
  if (!opts.forceRefresh) {
    const cached = loadNarrativeCache();
    if (cached) {
      log.info(`Usando cache de narrativas del día (${cached.tweets.length} tweets, guardado ${cached.savedAt})`);
      return { tweets: cached.tweets, byQuery: cached.byQuery || {} };
    }
  }

  // ── Check si la API está bloqueada (402) ──────────────────────────────────
  if (isSearchApiBlocked()) {
    return buildFallbackNarrativeData();
  }

  if (!config.twitter.bearerToken) {
    log.warn('Twitter Bearer Token no configurado - usando datos simulados');
    return buildFallbackNarrativeData();
  }

  const queries = CONSOLIDATED_QUERIES;
  log.info(`Iniciando búsqueda de tweets para ${queries.length} queries consolidadas...`);

  const byQuery = {};
  const allTweets = [];
  let paymentRequired = false;

  for (const query of queries) {
    if (paymentRequired) {
      byQuery[query] = [];
      continue;
    }

    try {
      log.info(`Buscando: "${query.substring(0, 60)}..."...`);
      const tweets = await searchRecentTweets(
        query,
        config.narrative.tweetsPerQuery
      );

      byQuery[query] = tweets;
      allTweets.push(...tweets);

      log.info(`  → ${tweets.length} tweets obtenidos`);
      await sleep(2000);
    } catch (err) {
      if (err.message && (err.message.includes('402') || err.message.includes('Payment Required'))) {
        log.warn('Twitter API requiere plan de pago. Marcando como bloqueada por 24h.');
        markSearchApiBlocked('402 Payment Required');
        paymentRequired = true;
      } else {
        log.error(`Error buscando: ${err.message}`);
      }
      byQuery[query] = [];
    }
  }

  // Si la API no está disponible, usar fallback
  if (paymentRequired || allTweets.length === 0) {
    log.warn('Usando datos de narrativas de fallback');
    const fallback = buildFallbackNarrativeData();
    // Guardar fallback en cache para no reintentar hoy
    saveNarrativeCache(fallback);
    return fallback;
  }

  const uniqueTweets = uniqueBy(allTweets, t => t.id);
  log.info(`Total: ${uniqueTweets.length} tweets únicos obtenidos`);

  const result = { tweets: uniqueTweets, byQuery };

  // ── Guardar en cache del día ─────────────────────────────────────────────
  saveNarrativeCache(result);
  log.info('Narrativas guardadas en cache del día');

  return result;
}

/**
 * Busca tweets sobre un token específico por nombre/símbolo
 * @param {string} tokenName
 * @param {string} tokenSymbol
 */
async function fetchTokenMentions(tokenName, tokenSymbol) {
  if (!config.twitter.bearerToken) return [];
  if (isSearchApiBlocked()) return [];

  try {
    const query = `(${tokenName} OR $${tokenSymbol}) crypto lang:en -is:retweet`;
    return await searchRecentTweets(query, 30);
  } catch (err) {
    if (err.message && err.message.includes('402')) {
      markSearchApiBlocked('402 en fetchTokenMentions');
    }
    log.error(`Error buscando menciones de ${tokenSymbol}: ${err.message}`);
    return [];
  }
}

// ─── Fallback para desarrollo sin API ─────────────────────────────────────────

function buildFallbackNarrativeData() {
  log.warn('Usando datos de narrativas de fallback (Twitter API no disponible)');

  const mockTweets = [
    {
      id: 'mock1',
      text: 'AI agents on blockchain are going to be massive. Bittensor is leading the way in decentralized ML infrastructure.',
      authorUsername: 'crypto_analyst',
      authorFollowers: 15000,
      likes: 234,
      retweets: 89,
      replies: 45,
      engagement: 456,
      hashtags: ['bittensor', 'ai', 'crypto'],
      mentions: [],
      createdAt: new Date().toISOString(),
      lang: 'en',
    },
    {
      id: 'mock2',
      text: 'Render Network compute demand is outpacing supply. The decentralized GPU narrative is real and RNDR is undervalued.',
      authorUsername: 'defi_researcher',
      authorFollowers: 28000,
      likes: 412,
      retweets: 156,
      replies: 67,
      engagement: 791,
      hashtags: ['render', 'rndr', 'decentralizedai'],
      mentions: [],
      createdAt: new Date().toISOString(),
      lang: 'en',
    },
    {
      id: 'mock3',
      text: 'The convergence of AI and crypto is not hype. Decentralized data marketplaces and compute networks are solving real problems.',
      authorUsername: 'web3_builder',
      authorFollowers: 9000,
      likes: 178,
      retweets: 67,
      replies: 34,
      engagement: 346,
      hashtags: ['ai', 'crypto', 'web3'],
      mentions: [],
      createdAt: new Date().toISOString(),
      lang: 'en',
    },
    {
      id: 'mock4',
      text: 'Fetch.ai autonomous agents performing cross-chain operations without human intervention. This is what the AI agent network narrative looks like in practice.',
      authorUsername: 'ai_crypto_news',
      authorFollowers: 43000,
      likes: 567,
      retweets: 234,
      replies: 89,
      engagement: 1124,
      hashtags: ['fetchai', 'fet', 'agents', 'autonomousai'],
      mentions: [],
      createdAt: new Date().toISOString(),
      lang: 'en',
    },
    {
      id: 'mock5',
      text: 'On-chain AI inference is getting cheaper with each passing month. The infrastructure layer is maturing faster than expected.',
      authorUsername: 'protocol_analyst',
      authorFollowers: 21000,
      likes: 289,
      retweets: 112,
      replies: 56,
      engagement: 569,
      hashtags: ['onchainai', 'crypto', 'infrastructure'],
      mentions: [],
      createdAt: new Date().toISOString(),
      lang: 'en',
    },
  ];

  const byQuery = {};
  for (const query of CONSOLIDATED_QUERIES) {
    byQuery[query] = mockTweets.slice(0, 3);
  }

  return { tweets: mockTweets, byQuery };
}

module.exports = {
  searchRecentTweets,
  fetchNarrativeTweets,
  fetchTokenMentions,
  isSearchApiBlocked,
  markSearchApiBlocked,
};
