'use strict';

const { createModuleLogger } = require('../utils/logger');
const { countOccurrences, sortByValueDesc, mean, uniqueBy } = require('../utils/helpers');
const { config } = require('../config');

const log = createModuleLogger('NarrativeDetector');

// ─── Stopwords ─────────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up',
  'about', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'between', 'out', 'off', 'over', 'under', 'again', 'further',
  'then', 'once', 'and', 'but', 'or', 'nor', 'so', 'yet', 'both',
  'either', 'neither', 'not', 'only', 'own', 'same', 'than', 'too',
  'very', 'just', 'this', 'that', 'these', 'those', 'it', 'its',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  'them', 'their', 'what', 'which', 'who', 'whom', 'when', 'where',
  'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'as', 'if', 'because', 'while', 'although',
  'get', 'got', 'go', 'going', 'like', 'also', 'new', 'one', 'two',
  'rt', 'via', 'https', 'http', 'amp', 'co', 'com',
]);

// Términos de dominio AI/crypto con peso aumentado
const DOMAIN_KEYWORDS = new Set([
  'bittensor', 'render', 'rndr', 'tao', 'fetch', 'fet', 'agix', 'ocean',
  'akash', 'akt', 'numerai', 'near', 'injective', 'graph', 'helium',
  'ai', 'agents', 'compute', 'inference', 'training', 'model', 'llm',
  'gpu', 'decentralized', 'autonomous', 'blockchain', 'onchain', 'protocol',
  'infrastructure', 'network', 'marketplace', 'data', 'intelligence',
  'singularity', 'agi', 'depin', 'validators', 'miners',
]);

// ─── Extracción de términos ────────────────────────────────────────────────────

/**
 * Extrae tokens (palabras clave) de un texto
 * @param {string} text
 * @returns {string[]}
 */
function extractTokens(text) {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')          // remover URLs
    .replace(/[@#$]\w+/g, m => m.slice(1))   // normalizar handles/hashtags/tickers
    .replace(/[^a-z0-9\s]/g, ' ')            // remover puntuación
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Extrae n-gramas de un array de tokens
 * @param {string[]} tokens
 * @param {number} n
 * @returns {string[]}
 */
function extractNGrams(tokens, n) {
  const ngrams = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(' '));
  }
  return ngrams;
}

// ─── Análisis de frecuencia ────────────────────────────────────────────────────

/**
 * Analiza frecuencia de términos en una colección de tweets
 * @param {Array} tweets
 * @returns {object}
 */
function analyzeTermFrequency(tweets) {
  const unigramCounts = {};
  const bigramCounts = {};
  const trigramCounts = {};
  const hashtagCounts = {};

  for (const tweet of tweets) {
    const tokens = extractTokens(tweet.text);
    const unigrams = tokens;
    const bigrams = extractNGrams(tokens, 2);
    const trigrams = extractNGrams(tokens, 3);

    for (const w of unigrams) {
      const weight = DOMAIN_KEYWORDS.has(w) ? 2 : 1;
      unigramCounts[w] = (unigramCounts[w] || 0) + weight;
    }
    for (const bg of bigrams) {
      bigramCounts[bg] = (bigramCounts[bg] || 0) + 1;
    }
    for (const tg of trigrams) {
      trigramCounts[tg] = (trigramCounts[tg] || 0) + 1;
    }
    for (const ht of tweet.hashtags || []) {
      hashtagCounts[ht] = (hashtagCounts[ht] || 0) + 1;
    }
  }

  return {
    unigrams: sortByValueDesc(unigramCounts),
    bigrams: sortByValueDesc(bigramCounts),
    trigrams: sortByValueDesc(trigramCounts),
    hashtags: sortByValueDesc(hashtagCounts),
  };
}

// ─── Detección de temas emergentes ────────────────────────────────────────────

/**
 * Detecta temas emergentes comparando menciones en ventanas temporales
 * @param {Array} tweets - Tweets con timestamp
 * @returns {Array} - Temas emergentes ordenados por score
 */
function detectEmergingTopics(tweets) {
  if (tweets.length < 5) return [];

  // Dividir en ventana reciente (últimas 12h) vs anterior
  const now = Date.now();
  const cutoff = now - 12 * 60 * 60 * 1000;

  const recentTweets = tweets.filter(t => new Date(t.createdAt).getTime() > cutoff);
  const olderTweets = tweets.filter(t => new Date(t.createdAt).getTime() <= cutoff);

  const recentFreq = analyzeTermFrequency(recentTweets);
  const olderFreq = analyzeTermFrequency(olderTweets);

  const emergingTopics = [];

  // Detectar términos con crecimiento de mención > 50%
  for (const [term, count] of Object.entries(recentFreq.unigrams)) {
    if (count < config.narrative.minMentionsThreshold) continue;

    const olderCount = olderFreq.unigrams[term] || 0;
    const growthRate = olderCount === 0
      ? count * 2                                     // nuevo término
      : (count - olderCount) / olderCount;

    if (growthRate > 0.5 || (olderCount === 0 && count >= 3)) {
      emergingTopics.push({
        term,
        recentCount: count,
        olderCount,
        growthRate,
        type: 'unigram',
        isDomainKeyword: DOMAIN_KEYWORDS.has(term),
      });
    }
  }

  // Bigrams emergentes
  for (const [term, count] of Object.entries(recentFreq.bigrams)) {
    if (count < 2) continue;

    const olderCount = olderFreq.bigrams[term] || 0;
    const growthRate = olderCount === 0 ? count * 2 : (count - olderCount) / olderCount;

    if (growthRate > 1.0 || (olderCount === 0 && count >= 2)) {
      emergingTopics.push({
        term,
        recentCount: count,
        olderCount,
        growthRate,
        type: 'bigram',
        isDomainKeyword: false,
      });
    }
  }

  // Ordenar por score compuesto
  return emergingTopics
    .sort((a, b) => {
      const scoreA = a.recentCount * (1 + a.growthRate) * (a.isDomainKeyword ? 1.5 : 1);
      const scoreB = b.recentCount * (1 + b.growthRate) * (b.isDomainKeyword ? 1.5 : 1);
      return scoreB - scoreA;
    })
    .slice(0, 20);
}

// ─── Clustering de narrativas ──────────────────────────────────────────────────

// Palabras clave por narrativa conocida
const NARRATIVE_SEEDS = {
  'AI Agent Networks': ['agents', 'autonomous', 'agent networks', 'multi-agent', 'agentic', 'fetch', 'fet'],
  'Decentralized Compute': ['compute', 'gpu', 'render', 'rndr', 'akash', 'inference', 'training'],
  'Decentralized AI Infrastructure': ['bittensor', 'tao', 'decentralized ai', 'subnet', 'validators', 'miners'],
  'AI Data Marketplaces': ['ocean', 'data marketplace', 'data economy', 'singularity', 'agix'],
  'DePIN AI': ['depin', 'physical infrastructure', 'helium', 'iot', 'decentralized network'],
  'On-Chain AI': ['on-chain', 'onchain', 'blockchain ai', 'smart contracts ai', 'inference on chain'],
  'AI Token Speculation': ['agi', 'narrative', 'pumping', 'mooning', 'undervalued', 'gem'],
};

/**
 * Clasifica tweets en narrativas conocidas
 * @param {Array} tweets
 * @returns {object}
 */
function clusterByNarrative(tweets) {
  const narrativeClusters = {};

  for (const [narrative, seeds] of Object.entries(NARRATIVE_SEEDS)) {
    narrativeClusters[narrative] = {
      name: narrative,
      tweets: [],
      tweetCount: 0,
      totalEngagement: 0,
      avgEngagement: 0,
      topTweets: [],
      seeds,
    };
  }

  for (const tweet of tweets) {
    const textLower = tweet.text.toLowerCase();

    for (const [narrative, seeds] of Object.entries(NARRATIVE_SEEDS)) {
      const match = seeds.some(seed => textLower.includes(seed));
      if (match) {
        narrativeClusters[narrative].tweets.push(tweet);
        narrativeClusters[narrative].tweetCount++;
        narrativeClusters[narrative].totalEngagement += tweet.engagement || 0;
      }
    }
  }

  // Calcular métricas y seleccionar top tweets
  for (const [name, cluster] of Object.entries(narrativeClusters)) {
    cluster.avgEngagement = cluster.tweetCount > 0
      ? cluster.totalEngagement / cluster.tweetCount
      : 0;

    cluster.topTweets = [...cluster.tweets]
      .sort((a, b) => (b.engagement || 0) - (a.engagement || 0))
      .slice(0, 5)
      .map(t => ({ text: t.text, engagement: t.engagement, author: t.authorUsername }));

    // No mantener todos los tweets en memoria
    delete cluster.tweets;
  }

  return narrativeClusters;
}

// ─── Score de narrativas ───────────────────────────────────────────────────────

/**
 * Calcula score de fuerza de cada narrativa (0-100)
 * @param {object} clusters
 * @param {number} totalTweets
 * @returns {Array}
 */
function scoreNarratives(clusters, totalTweets) {
  const maxTweets = Math.max(...Object.values(clusters).map(c => c.tweetCount), 1);
  const maxEngagement = Math.max(...Object.values(clusters).map(c => c.avgEngagement), 1);

  return Object.entries(clusters)
    .map(([name, cluster]) => {
      const tweetScore = (cluster.tweetCount / maxTweets) * 60;
      const engagementScore = (cluster.avgEngagement / maxEngagement) * 40;
      const score = Math.round(tweetScore + engagementScore);

      return {
        narrative: name,
        score,
        tweetCount: cluster.tweetCount,
        totalEngagement: cluster.totalEngagement,
        avgEngagement: Math.round(cluster.avgEngagement),
        shareOfVoice: totalTweets > 0
          ? ((cluster.tweetCount / totalTweets) * 100).toFixed(1)
          : 0,
        strength:
          score >= 70 ? 'dominant'
          : score >= 45 ? 'strong'
          : score >= 25 ? 'emerging'
          : score >= 10 ? 'weak'
          : 'minimal',
        topTweets: cluster.topTweets,
      };
    })
    .sort((a, b) => b.score - a.score);
}

// ─── Análisis de sentimiento básico ───────────────────────────────────────────

const POSITIVE_WORDS = new Set([
  'bullish', 'pump', 'surge', 'rally', 'moon', 'uptrend', 'breakout',
  'massive', 'undervalued', 'strong', 'growing', 'adoption', 'build',
  'launch', 'leading', 'potential', 'real', 'solid', 'legitimate',
  'innovative', 'revolutionary', 'transforming', 'dominating',
]);

const NEGATIVE_WORDS = new Set([
  'bearish', 'dump', 'crash', 'sell', 'overvalued', 'hype', 'scam',
  'fake', 'dead', 'failing', 'declining', 'risky', 'concern', 'warning',
  'manipulation', 'bubble', 'broken', 'slow', 'centralized', 'rug',
]);

/**
 * Análisis de sentimiento basado en lexicón
 * @param {Array} tweets
 * @returns {object}
 */
function analyzeSentiment(tweets) {
  let positiveScore = 0;
  let negativeScore = 0;
  let neutralCount = 0;

  for (const tweet of tweets) {
    const tokens = extractTokens(tweet.text);
    let tweetPositive = 0;
    let tweetNegative = 0;

    for (const token of tokens) {
      if (POSITIVE_WORDS.has(token)) tweetPositive++;
      if (NEGATIVE_WORDS.has(token)) tweetNegative++;
    }

    const weight = Math.log(1 + (tweet.engagement || 0));
    positiveScore += tweetPositive * weight;
    negativeScore += tweetNegative * weight;
    if (tweetPositive === 0 && tweetNegative === 0) neutralCount++;
  }

  const total = positiveScore + negativeScore;
  const sentimentScore = total === 0 ? 0 : (positiveScore - negativeScore) / total;

  return {
    score: sentimentScore,                // -1 (bearish) a +1 (bullish)
    label: sentimentScore > 0.2 ? 'bullish'
         : sentimentScore < -0.2 ? 'bearish'
         : 'neutral',
    positiveWeight: Math.round(positiveScore),
    negativeWeight: Math.round(negativeScore),
    neutralTweets: neutralCount,
    distribution: {
      positive: total > 0 ? ((positiveScore / total) * 100).toFixed(1) : 50,
      negative: total > 0 ? ((negativeScore / total) * 100).toFixed(1) : 50,
    },
  };
}

// ─── Pipeline principal de detección ──────────────────────────────────────────

/**
 * Ejecuta el análisis completo de narrativas
 * @param {object} tweetData - { tweets, byQuery }
 * @returns {object}
 */
function detectNarratives(tweetData) {
  const { tweets, byQuery } = tweetData;
  log.info(`Analizando ${tweets.length} tweets para detectar narrativas...`);

  // 1. Frecuencia de términos
  const termFrequency = analyzeTermFrequency(tweets);

  // 2. Temas emergentes
  const emergingTopics = detectEmergingTopics(tweets);

  // 3. Clustering por narrativa
  const clusters = clusterByNarrative(tweets);

  // 4. Score de narrativas
  const narrativeScores = scoreNarratives(clusters, tweets.length);

  // 5. Sentimiento general
  const sentiment = analyzeSentiment(tweets);

  // 6. Tokens más mencionados
  const tokenMentions = extractTokenMentions(tweets);

  // 7. Métricas por query
  const queryMetrics = buildQueryMetrics(byQuery);

  const result = {
    analyzedAt: new Date().toISOString(),
    totalTweets: tweets.length,
    sentiment,
    narrativeScores,
    emergingTopics: emergingTopics.slice(0, 10),
    topTerms: {
      unigrams: Object.entries(termFrequency.unigrams).slice(0, 20).map(([term, count]) => ({ term, count })),
      bigrams: Object.entries(termFrequency.bigrams).slice(0, 10).map(([term, count]) => ({ term, count })),
      hashtags: Object.entries(termFrequency.hashtags).slice(0, 15).map(([tag, count]) => ({ tag, count })),
    },
    tokenMentions,
    queryMetrics,
    dominantNarrative: narrativeScores[0] || null,
    emergingNarrative: narrativeScores.find(n => n.strength === 'emerging') || null,
    summary: buildNarrativeSummary(narrativeScores, emergingTopics, sentiment, tokenMentions),
  };

  log.info(`Narrativa dominante: ${result.dominantNarrative?.narrative} (score: ${result.dominantNarrative?.score})`);
  log.info(`Sentimiento general: ${sentiment.label} (${sentiment.score.toFixed(2)})`);

  return result;
}

/**
 * Extrae menciones de tokens específicos de AI
 */
function extractTokenMentions(tweets) {
  const tokenPatterns = [
    { symbol: 'TAO', patterns: ['tao', 'bittensor'] },
    { symbol: 'RNDR', patterns: ['rndr', 'render'] },
    { symbol: 'FET', patterns: ['fet', 'fetch.ai', 'fetchai'] },
    { symbol: 'AGIX', patterns: ['agix', 'singularitynet', 'singularity'] },
    { symbol: 'OCEAN', patterns: ['ocean', 'ocean protocol'] },
    { symbol: 'AKT', patterns: ['akt', 'akash'] },
    { symbol: 'NMR', patterns: ['nmr', 'numerai'] },
    { symbol: 'NEAR', patterns: ['near protocol', '$near'] },
    { symbol: 'INJ', patterns: ['inj', 'injective'] },
    { symbol: 'GRT', patterns: ['grt', 'the graph'] },
  ];

  const counts = {};

  for (const { symbol, patterns } of tokenPatterns) {
    let count = 0;
    let totalEngagement = 0;

    for (const tweet of tweets) {
      const textLower = tweet.text.toLowerCase();
      if (patterns.some(p => textLower.includes(p))) {
        count++;
        totalEngagement += tweet.engagement || 0;
      }
    }

    if (count > 0) {
      counts[symbol] = { count, totalEngagement, avgEngagement: Math.round(totalEngagement / count) };
    }
  }

  return Object.entries(counts)
    .sort(([, a], [, b]) => b.count - a.count)
    .map(([symbol, data]) => ({ symbol, ...data }));
}

/**
 * Métricas por query de búsqueda
 */
function buildQueryMetrics(byQuery) {
  return Object.entries(byQuery).map(([query, tweets]) => ({
    query,
    tweetCount: tweets.length,
    avgEngagement: tweets.length > 0
      ? Math.round(mean(tweets.map(t => t.engagement || 0)))
      : 0,
    topTweet: tweets.sort((a, b) => (b.engagement || 0) - (a.engagement || 0))[0] || null,
  }));
}

/**
 * Construye resumen textual de narrativas
 */
function buildNarrativeSummary(narrativeScores, emergingTopics, sentiment, tokenMentions) {
  const top3 = narrativeScores.slice(0, 3).map(n => n.narrative);
  const topTokens = tokenMentions.slice(0, 3).map(t => t.symbol);
  const emerging = emergingTopics.slice(0, 3).map(e => e.term);

  return {
    leadingNarratives: top3,
    dominantSentiment: sentiment.label,
    mostMentionedTokens: topTokens,
    emergingTerms: emerging,
    insights: generateNarrativeInsights(narrativeScores, emergingTopics, sentiment, tokenMentions),
  };
}

function generateNarrativeInsights(narrativeScores, emergingTopics, sentiment, tokenMentions) {
  const insights = [];

  const dominant = narrativeScores[0];
  if (dominant && dominant.score > 30) {
    insights.push(`${dominant.narrative} is the dominant narrative with ${dominant.tweetCount} mentions and ${dominant.avgEngagement} avg engagement.`);
  }

  const emerging = narrativeScores.find(n => n.strength === 'emerging');
  if (emerging) {
    insights.push(`${emerging.narrative} is gaining traction with ${emerging.tweetCount} mentions.`);
  }

  if (tokenMentions[0]) {
    insights.push(`${tokenMentions[0].symbol} is the most discussed token with ${tokenMentions[0].count} direct mentions.`);
  }

  if (emergingTopics[0] && emergingTopics[0].growthRate > 1) {
    insights.push(`The term "${emergingTopics[0].term}" is gaining momentum (${(emergingTopics[0].growthRate * 100).toFixed(0)}% growth rate in recent 12h).`);
  }

  const highNegative = narrativeScores.find(n => n.score < 15 && n.tweetCount > 2);
  if (highNegative) {
    insights.push(`${highNegative.narrative} has low engagement relative to mentions - potential narrative fatigue.`);
  }

  return insights;
}

module.exports = {
  detectNarratives,
  analyzeTermFrequency,
  detectEmergingTopics,
  clusterByNarrative,
  analyzeSentiment,
  extractTokenMentions,
};
