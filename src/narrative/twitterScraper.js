'use strict';

const { TwitterApi } = require('twitter-api-v2');
const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { withRetry, sleep } = require('../utils/retry');
const { uniqueBy } = require('../utils/helpers');

const log = createModuleLogger('TwitterScraper');

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

// ─── Búsqueda multi-query ──────────────────────────────────────────────────────

/**
 * Ejecuta búsquedas para todas las queries de narrative
 * @returns {Promise<object>} - { tweets: [], byQuery: {} }
 */
async function fetchNarrativeTweets() {
  log.info(`Iniciando búsqueda de tweets para ${config.narrative.searchQueries.length} queries...`);

  if (!config.twitter.bearerToken) {
    log.warn('Twitter Bearer Token no configurado - usando datos simulados para desarrollo');
    return buildFallbackNarrativeData();
  }

  const byQuery = {};
  const allTweets = [];
  let paymentRequired = false;

  for (const query of config.narrative.searchQueries) {
    // Si ya detectamos que la API requiere pago, no seguir intentando
    if (paymentRequired) {
      byQuery[query] = [];
      continue;
    }

    try {
      log.info(`Buscando: "${query}"...`);
      const tweets = await searchRecentTweets(
        `(${query}) lang:en -is:retweet`,
        config.narrative.tweetsPerQuery
      );

      byQuery[query] = tweets;
      allTweets.push(...tweets);

      log.info(`"${query}": ${tweets.length} tweets obtenidos`);
      await sleep(2000);
    } catch (err) {
      // Error 402 = plan de pago requerido → usar fallback inmediatamente
      if (err.message && err.message.includes('402')) {
        log.warn('Twitter API requiere plan de pago para búsqueda. Usando datos de fallback.');
        paymentRequired = true;
      } else {
        log.error(`Error buscando "${query}": ${err.message}`);
      }
      byQuery[query] = [];
    }
  }

  // Si la API no está disponible, usar fallback
  if (paymentRequired || allTweets.length === 0) {
    log.warn('Usando datos de narrativas de fallback (Twitter Search API no disponible en plan actual)');
    return buildFallbackNarrativeData();
  }

  const uniqueTweets = uniqueBy(allTweets, t => t.id);
  log.info(`Total: ${uniqueTweets.length} tweets únicos obtenidos`);
  return { tweets: uniqueTweets, byQuery };
}

/**
 * Busca tweets sobre un token específico por nombre/símbolo
 * @param {string} tokenName
 * @param {string} tokenSymbol
 */
async function fetchTokenMentions(tokenName, tokenSymbol) {
  if (!config.twitter.bearerToken) return [];

  try {
    const query = `(${tokenName} OR $${tokenSymbol}) crypto lang:en -is:retweet`;
    return await searchRecentTweets(query, 30);
  } catch (err) {
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
  for (const query of config.narrative.searchQueries) {
    byQuery[query] = mockTweets.slice(0, 3);
  }

  return { tweets: mockTweets, byQuery };
}

module.exports = {
  searchRecentTweets,
  fetchNarrativeTweets,
  fetchTokenMentions,
};
