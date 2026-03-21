'use strict';

const OpenAI = require('openai');
const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const log = createModuleLogger('SentimentAnalyzer');

let _openai = null;

function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: config.openai.apiKey });
  return _openai;
}

/**
 * Usa GPT para analizar y resumir narrativas de forma avanzada
 * @param {object} narrativeData - Salida del detectNarratives
 * @param {Array} technicalAnalyses - Análisis técnico de los tokens
 * @returns {Promise<object>}
 */
async function analyzeNarrativesWithAI(narrativeData, technicalAnalyses) {
  log.info('Ejecutando análisis de narrativas con GPT...');

  const topNarratives = narrativeData.narrativeScores.slice(0, 5);
  const topTokenMentions = narrativeData.tokenMentions.slice(0, 5);
  const emergingTopics = narrativeData.emergingTopics.slice(0, 5);
  const sentiment = narrativeData.sentiment;

  // Construir contexto técnico resumido
  const techContext = technicalAnalyses.slice(0, 5).map(t => ({
    symbol: t.symbol,
    price: t.currentPrice,
    change24h: t.change24h?.toFixed(2),
    rsi: t.indicators?.rsi?.toFixed(1),
    bias: t.bias,
    trend: t.maTrend,
    score: t.technicalScore,
  }));

  const prompt = `You are a senior AI crypto market analyst. Analyze the following data and produce structured insights.

NARRATIVE DATA (from Twitter/X analysis, last 24h):
- Total tweets analyzed: ${narrativeData.totalTweets}
- Dominant narratives: ${JSON.stringify(topNarratives.map(n => ({ name: n.narrative, score: n.score, tweets: n.tweetCount, strength: n.strength })))}
- Token mentions: ${JSON.stringify(topTokenMentions)}
- Emerging terms: ${JSON.stringify(emergingTopics.map(e => e.term))}
- Overall sentiment: ${sentiment.label} (score: ${sentiment.score.toFixed(2)})
- Positive/Negative distribution: ${sentiment.distribution.positive}% / ${sentiment.distribution.negative}%

TECHNICAL CONTEXT (top AI tokens):
${JSON.stringify(techContext, null, 2)}

Produce a JSON response with this EXACT structure:
{
  "overallNarrativeAssessment": "2-3 sentences describing the current state of AI crypto narratives",
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "narrativeLeadingPrice": {
    "tokens": ["TOKEN1", "TOKEN2"],
    "explanation": "brief explanation"
  },
  "divergences": ["divergence 1 if any"],
  "emergingNarrativeAlert": {
    "topic": "topic name or null",
    "confidence": "high/medium/low",
    "rationale": "brief explanation"
  },
  "marketSentimentSummary": "one sentence",
  "contentAngles": [
    "Content angle 1 for tweet generation",
    "Content angle 2 for tweet generation",
    "Content angle 3 for tweet generation"
  ]
}

Rules: Be analytical. No hype. No predictions. Data-driven observations only.`;

  const response = await withRetry(
    async () => {
      const openai = getOpenAI();
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1000,
      });
      return JSON.parse(completion.choices[0].message.content);
    },
    { label: 'analyzeNarrativesWithAI', ...config.retry }
  );

  log.info('Análisis narrativo con AI completado');
  return response;
}

/**
 * Detecta si hay divergencia entre narrativa y precio
 * @param {object} narrativeData
 * @param {Array} techAnalyses
 * @returns {Array<object>}
 */
function detectNarrativePriceDivergences(narrativeData, techAnalyses) {
  const divergences = [];

  const tokenMentionMap = {};
  for (const mention of narrativeData.tokenMentions) {
    tokenMentionMap[mention.symbol] = mention;
  }

  for (const tech of techAnalyses) {
    const mention = tokenMentionMap[tech.symbol];
    if (!mention) continue;

    const narrativeStrength = mention.count / Math.max(...narrativeData.tokenMentions.map(m => m.count), 1);
    const techBullish = tech.bias === 'bullish';
    const techBearish = tech.bias === 'bearish';

    // Alta mención + precio bajista = narrativa liderando precio (potencial compra)
    if (narrativeStrength > 0.4 && techBearish && tech.change24h < -3) {
      divergences.push({
        type: 'narrative_leading_price',
        symbol: tech.symbol,
        narrativeStrength: (narrativeStrength * 100).toFixed(1),
        priceChange24h: tech.change24h,
        bias: tech.bias,
        signal: 'Narrative gaining momentum while price lags - watch for convergence',
      });
    }

    // Poca mención + precio alcista = precio puede corregir (sin soporte narrativo)
    if (narrativeStrength < 0.1 && techBullish && tech.change24h > 8) {
      divergences.push({
        type: 'price_leading_narrative',
        symbol: tech.symbol,
        narrativeStrength: (narrativeStrength * 100).toFixed(1),
        priceChange24h: tech.change24h,
        bias: tech.bias,
        signal: 'Price running without narrative support - potential exhaustion risk',
      });
    }
  }

  return divergences;
}

module.exports = {
  analyzeNarrativesWithAI,
  detectNarrativePriceDivergences,
};
