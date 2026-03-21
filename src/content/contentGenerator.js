'use strict';

const OpenAI = require('openai');
const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const { formatPrice, formatPct, formatVolume, todayISO } = require('../utils/helpers');

const log = createModuleLogger('ContentGenerator');

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: config.openai.apiKey });
  return _openai;
}

// ─── Tipos de contenido ────────────────────────────────────────────────────────

const TWEET_TYPES = {
  MARKET_INSIGHT: 'market_insight',
  TECHNICAL_ANALYSIS: 'technical_analysis',
  NARRATIVE_INSIGHT: 'narrative_insight',
  CONTRARIAN: 'contrarian',
  SYSTEM_THINKING: 'system_thinking',
  DIVERGENCE: 'divergence',
};

// ─── System prompt base ────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are an anonymous senior AI crypto analyst with deep expertise in decentralized AI infrastructure, tokenomics, and on-chain data analysis. You write concise, high-signal content for a sophisticated crypto audience.

VOICE AND STYLE:
- Analytical, direct, and precise
- English only
- Zero emojis
- No hashtags
- No promotional language
- No guaranteed predictions or financial advice
- Use specific data points and numbers
- Write like a quant analyst, not a marketer
- Contrarian thinking is valued
- Systems-level observations over surface-level commentary

TWEET CONSTRAINTS:
- Maximum 270 characters per tweet
- One clear, specific insight per tweet
- Open with the most important data point
- No filler phrases ("in my opinion", "I think", "it seems")
- No calls to action ("follow me", "RT", "check out")
- No rhetorical questions as hooks
- Avoid clichés: "mind-blowing", "game-changer", "revolutionary", "massive"`;

// ─── Generadores por tipo ──────────────────────────────────────────────────────

/**
 * Genera tweet de insight de mercado
 */
async function generateMarketInsightTweet(fusionData) {
  const { macroSignals, tokens } = fusionData;
  const top = tokens[0];

  const prompt = `Generate a market insight tweet about the AI crypto sector.

MARKET DATA:
- AI sector market phase: ${macroSignals.marketPhase.replace('_', ' ')}
- Average 24h change across AI tokens: ${macroSignals.avgChange24h}%
- Bullish/Bearish token ratio: ${macroSignals.bullishTokenCount}/${macroSignals.bearishTokenCount}
- Dominant narrative: ${macroSignals.dominantNarrative}
- Narrative strength: ${macroSignals.narrativeStrength}
- Overall sentiment: ${macroSignals.overallSentiment}
- Top performer 24h: ${macroSignals.topGainers?.[0]?.symbol} (${macroSignals.topGainers?.[0]?.change24h?.toFixed(1)}%)
- Weakest 24h: ${macroSignals.topLosers?.[0]?.symbol} (${macroSignals.topLosers?.[0]?.change24h?.toFixed(1)}%)
- Leading token composite score: ${top?.symbol} (${top?.compositeScore}/100)

Generate ONE tweet maximum 270 characters. Focus on a non-obvious market observation. Return ONLY the tweet text, nothing else.`;

  return callGPT(prompt, TWEET_TYPES.MARKET_INSIGHT);
}

/**
 * Genera tweet de análisis técnico
 */
async function generateTechnicalTweet(fusionData) {
  const { tokens } = fusionData;
  const techInsight = fusionData.contentInsights?.technicalInsight;

  // Seleccionar el token más interesante técnicamente
  const focusToken = tokens.find(t => t.symbol === techInsight?.focusToken) || tokens[0];
  if (!focusToken) return null;

  const prompt = `Generate a technical analysis tweet for ${focusToken.symbol} (${focusToken.name}).

TECHNICAL DATA:
- Current price: ${formatPrice(focusToken.currentPrice)}
- 24h change: ${formatPct(focusToken.change24h || 0)}
- RSI(14): ${focusToken.rsi?.toFixed(1) || 'N/A'}
- MACD: ${focusToken.macd || 'N/A'}
- MA trend: ${focusToken.maTrend?.replace(/_/g, ' ')}
- Technical bias: ${focusToken.technicalBias}
- Technical score: ${focusToken.technicalScore}/100
- Breakout signal: ${focusToken.breakout?.type?.replace(/_/g, ' ') || 'none'}
${focusToken.breakout?.pctAbove ? `- Breakout level exceeded by: ${focusToken.breakout.pctAbove.toFixed(2)}%` : ''}
- Volume trend: ${fusionData.tokens.find(t => t.symbol === focusToken.symbol)?.volumeTrend?.label || 'N/A'}
- Key signals: ${focusToken.topSignals?.join('; ') || 'none'}

Generate ONE tweet maximum 270 characters with specific technical data points. Return ONLY the tweet text.`;

  return callGPT(prompt, TWEET_TYPES.TECHNICAL_ANALYSIS);
}

/**
 * Genera tweet de insight narrativo
 */
async function generateNarrativeTweet(fusionData) {
  const { narrativeSummary, aiNarrativeAnalysis, macroSignals } = fusionData;

  const prompt = `Generate a narrative insight tweet about AI crypto discourse trends.

NARRATIVE DATA:
- Dominant narrative: ${macroSignals.dominantNarrative}
- Narrative strength: ${macroSignals.narrativeStrength}
- Sentiment: ${macroSignals.overallSentiment}
- Most discussed tokens: ${narrativeSummary?.mostMentionedTokens?.join(', ')}
- Emerging terms in last 12h: ${narrativeSummary?.emergingTerms?.join(', ')}
- AI analysis: ${aiNarrativeAnalysis?.overallNarrativeAssessment || ''}
- Key insight: ${aiNarrativeAnalysis?.keyInsights?.[0] || ''}
- Emerging narrative alert: ${aiNarrativeAnalysis?.emergingNarrativeAlert?.topic || 'none'} (${aiNarrativeAnalysis?.emergingNarrativeAlert?.confidence || ''})

Generate ONE tweet maximum 270 characters about what the market narrative data signals. Return ONLY the tweet text.`;

  return callGPT(prompt, TWEET_TYPES.NARRATIVE_INSIGHT);
}

/**
 * Genera tweet contrarian
 */
async function generateContrarianTweet(fusionData) {
  const { contentInsights, tokens, macroSignals } = fusionData;
  const insight = contentInsights?.contrarianInsight;

  const divergences = fusionData.topDivergences || [];
  const focusToken = insight?.focusToken
    ? tokens.find(t => t.symbol === insight.focusToken)
    : null;

  const prompt = `Generate a contrarian take tweet about AI crypto markets.

CONTRARIAN ANGLE:
${insight?.headline || ''}

DATA POINTS:
${insight?.dataPoints?.join('\n') || ''}

DIVERGENCES:
${divergences.map(d => d.divergence?.description || '').join('\n') || 'none'}

MARKET CONTEXT:
- Market phase: ${macroSignals.marketPhase}
- Narrative strength: ${macroSignals.narrativeStrength}
${focusToken ? `
FOCUS TOKEN (${focusToken.symbol}):
- Price change 24h: ${formatPct(focusToken.change24h || 0)}
- Technical score: ${focusToken.technicalScore}/100
- Narrative score: ${focusToken.narrativeScore}/100
- Alignment: ${focusToken.alignment?.label}` : ''}

Generate ONE contrarian tweet maximum 270 characters. Challenge a mainstream view with data. Return ONLY the tweet text.`;

  return callGPT(prompt, TWEET_TYPES.CONTRARIAN);
}

/**
 * Genera tweet de pensamiento sistémico
 */
async function generateSystemTweet(fusionData) {
  const { contentInsights, macroSignals, narrativeSummary } = fusionData;

  const prompt = `Generate a systems-level thinking tweet about decentralized AI infrastructure.

SYSTEM DATA:
- Market phase: ${macroSignals.marketPhase}
- Dominant infrastructure narrative: ${macroSignals.dominantNarrative}
- Narrative sentiment: ${macroSignals.overallSentiment}
- Leading insights: ${contentInsights?.systemInsight?.dataPoints?.join('; ') || ''}
- AI analysis: ${fusionData.aiNarrativeAnalysis?.overallNarrativeAssessment || ''}

Generate ONE tweet maximum 270 characters with a structural observation about decentralized AI. Return ONLY the tweet text.`;

  return callGPT(prompt, TWEET_TYPES.SYSTEM_THINKING);
}

// ─── Generación de threads ─────────────────────────────────────────────────────

/**
 * Genera un thread completo de análisis
 */
async function generateThread(fusionData) {
  log.info('Generando thread de análisis...');

  const { tokens, macroSignals, narrativeSummary, aiNarrativeAnalysis } = fusionData;
  const topTokens = tokens.slice(0, 5);
  const date = todayISO();

  const prompt = `Generate a Twitter thread analyzing the AI crypto sector for ${date}.

FULL MARKET DATA:
Market Phase: ${macroSignals.marketPhase.replace('_', ' ')}
AI Sector avg 24h: ${macroSignals.avgChange24h}%
Bullish/Bearish: ${macroSignals.bullishTokenCount}/${macroSignals.bearishTokenCount} tokens
Dominant narrative: ${macroSignals.dominantNarrative} (${macroSignals.narrativeStrength})
Sentiment: ${macroSignals.overallSentiment}

TOP AI TOKENS:
${topTokens.map(t => `- ${t.symbol}: ${formatPrice(t.currentPrice)}, ${formatPct(t.change24h || 0)}, RSI ${t.rsi?.toFixed(1)}, bias: ${t.technicalBias}, composite: ${t.compositeScore}/100`).join('\n')}

NARRATIVE ANALYSIS:
Most discussed: ${narrativeSummary?.mostMentionedTokens?.join(', ')}
Emerging: ${narrativeSummary?.emergingTerms?.join(', ')}
AI Summary: ${aiNarrativeAnalysis?.overallNarrativeAssessment}
Key Insight: ${aiNarrativeAnalysis?.keyInsights?.[0]}

DIVERGENCES:
${fusionData.topDivergences?.map(d => d.divergence?.description).filter(Boolean).join('\n') || 'none'}

Generate a Twitter thread as a JSON array of tweet objects. Each tweet max 270 characters. Format:
[
  {"tweet": "Opening tweet - hook with a key data point", "type": "hook"},
  {"tweet": "Tweet 2 - market overview data", "type": "market"},
  {"tweet": "Tweet 3 - top performing token technical analysis", "type": "technical"},
  {"tweet": "Tweet 4 - narrative analysis observation", "type": "narrative"},
  {"tweet": "Tweet 5 - divergence or contrarian insight", "type": "contrarian"},
  {"tweet": "Tweet 6 - closing synthesis/structural insight", "type": "synthesis"}
]

Rules: No emojis, no hashtags, no promotional language, specific data, analytical tone.`;

  const response = await withRetry(
    async () => {
      const openai = getOpenAI();
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [
          { role: 'system', content: BASE_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.5,
        max_tokens: 2000,
      });
      const content = JSON.parse(completion.choices[0].message.content);
      return Array.isArray(content) ? content : content.thread || content.tweets || [];
    },
    { label: 'generateThread', ...config.retry }
  );

  log.info(`Thread generado con ${response.length} tweets`);

  return {
    type: 'thread',
    date: todayISO(),
    tweets: response,
    tweetCount: response.length,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Pipeline diario de generación ────────────────────────────────────────────

/**
 * Genera el conjunto completo de tweets diarios
 * @param {object} fusionData
 * @param {boolean} includeThread
 * @param {string|null} targetType - Si se pasa, solo genera 1 tweet de ese tipo
 * @returns {Promise<object>}
 */
async function generateDailyContent(fusionData, includeThread = false, targetType = null) {
  log.info(`Iniciando generación de contenido${targetType ? ` (tipo: ${targetType})` : ' diario'}...`);

  // ─── Modo single-tweet: genera exactamente 1 tweet del tipo pedido ───────────
  if (targetType) {
    const generatorMap = {
      [TWEET_TYPES.MARKET_INSIGHT]:    generateMarketInsightTweet,
      [TWEET_TYPES.TECHNICAL_ANALYSIS]: generateTechnicalTweet,
      [TWEET_TYPES.NARRATIVE_INSIGHT]:  generateNarrativeTweet,
      [TWEET_TYPES.CONTRARIAN]:         generateContrarianTweet,
      [TWEET_TYPES.SYSTEM_THINKING]:    generateSystemTweet,
    };
    const generator = generatorMap[targetType];
    if (!generator) throw new Error(`Tipo de tweet desconocido: ${targetType}`);

    log.info(`Generando tweet único tipo: ${targetType}`);
    const tweetContent = await generator(fusionData);
    const tweets = tweetContent ? [{
      id: `tweet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: targetType,
      content: tweetContent,
      charCount: tweetContent.length,
      scheduledFor: null,
      posted: false,
      postId: null,
      generatedAt: new Date().toISOString(),
    }] : [];

    return {
      date: new Date().toISOString().split('T')[0],
      tweets,
      thread: null,
      generatedAt: new Date().toISOString(),
      stats: { tweetsGenerated: tweets.length, hasThread: false, threadLength: 0 },
    };
  }

  // ─── Modo normal: genera todos los tweets del día ────────────────────────────
  const tweetTypes = [
    { type: TWEET_TYPES.MARKET_INSIGHT, generator: generateMarketInsightTweet },
    { type: TWEET_TYPES.TECHNICAL_ANALYSIS, generator: generateTechnicalTweet },
    { type: TWEET_TYPES.NARRATIVE_INSIGHT, generator: generateNarrativeTweet },
  ];

  // Agregar contrarian o system thinking aleatoriamente
  if (Math.random() > 0.5) {
    tweetTypes.push({ type: TWEET_TYPES.CONTRARIAN, generator: generateContrarianTweet });
  } else {
    tweetTypes.push({ type: TWEET_TYPES.SYSTEM_THINKING, generator: generateSystemTweet });
  }

  const tweets = [];

  for (const { type, generator } of tweetTypes.slice(0, config.content.tweetsPerDay)) {
    try {
      log.info(`Generando tweet tipo: ${type}`);
      const tweetContent = await generator(fusionData);

      if (tweetContent) {
        tweets.push({
          id: `tweet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type,
          content: tweetContent,
          charCount: tweetContent.length,
          scheduledFor: null, // se asigna en el pipeline
          posted: false,
          postId: null,
          generatedAt: new Date().toISOString(),
        });
        log.info(`Tweet ${type} generado (${tweetContent.length} chars)`);
      }
    } catch (err) {
      log.error(`Error generando tweet tipo ${type}: ${err.message}`);
    }
  }

  let thread = null;
  if (includeThread) {
    try {
      thread = await generateThread(fusionData);
    } catch (err) {
      log.error(`Error generando thread: ${err.message}`);
    }
  }

  const result = {
    date: todayISO(),
    tweets,
    thread,
    generatedAt: new Date().toISOString(),
    stats: {
      tweetsGenerated: tweets.length,
      hasThread: !!thread,
      threadLength: thread?.tweetCount || 0,
    },
  };

  log.info(`Contenido diario generado: ${tweets.length} tweets${thread ? ` + thread de ${thread.tweetCount} partes` : ''}`);
  return result;
}

// ─── Helper de llamada a GPT ───────────────────────────────────────────────────

async function callGPT(userPrompt, tweetType) {
  const MAX_CHAR = 278;
  const MAX_REGEN_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_REGEN_ATTEMPTS; attempt++) {
    const extraInstruction = attempt > 1
      ? `\n\nCRITICAL: Your previous response was too long. This time you MUST write UNDER ${MAX_CHAR} characters. Count carefully before responding.`
      : '';

    const response = await withRetry(
      async () => {
        const openai = getOpenAI();
        const completion = await openai.chat.completions.create({
          model: config.openai.model,
          messages: [
            { role: 'system', content: BASE_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt + extraInstruction },
          ],
          temperature: attempt > 1 ? 0.4 : 0.6,
          max_tokens: 300,
        });
        return completion.choices[0].message.content.trim();
      },
      { label: `callGPT(${tweetType})`, ...config.retry }
    );

    // Limpiar comillas envolventes
    const text = response.replace(/^["']|["']$/g, '').trim();

    if (text.length <= MAX_CHAR) {
      if (attempt > 1) {
        log.info(`Tweet regenerado OK en intento ${attempt} (${text.length} chars)`);
      }
      return text;
    }

    log.warn(`Tweet demasiado largo en intento ${attempt}: ${text.length} chars > ${MAX_CHAR}. Regenerando...`);
  }

  // Si después de MAX_REGEN_ATTEMPTS sigue largo, loguear error y retornar null (no publicar)
  log.error(`Tweet tipo ${tweetType} superó ${MAX_CHAR} chars en todos los intentos. Descartando.`);
  return null;
}

module.exports = {
  generateDailyContent,
  generateMarketInsightTweet,
  generateTechnicalTweet,
  generateNarrativeTweet,
  generateContrarianTweet,
  generateSystemTweet,
  generateThread,
  TWEET_TYPES,
};
