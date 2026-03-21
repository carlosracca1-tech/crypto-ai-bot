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

const BASE_SYSTEM_PROMPT = `You are a top crypto operator — sharp, experienced, slightly contrarian. You've been trading AI tokens since before the narrative exploded. You share real-time reads on the market in plain English. No jargon. No report language. Pure signal.

YOUR TWEET STRUCTURE (always follow this):
1. HOOK — first line stops the scroll. One punchy observation or tension point.
2. INSIGHT — one concrete data point or signal, explained in plain English. Not a number dump.
3. TAKE — your interpretation. What does this mean? Who gets trapped? What's the non-obvious move?

FORMAT RULES:
- 3 to 4 short lines max. Never a dense paragraph.
- Each line should feel like a separate punch.
- Use line breaks between hook, insight, and take.
- English only. No emojis. No hashtags. No "follow for more".
- No financial advice. No guaranteed calls.

VOICE — sound like this:
- "momentum is building but nobody's talking about it"
- "price isn't breaking — that's the signal"
- "this is where people get trapped"
- "market is pricing in X but the data says Y"
- "the narrative is loud. the price is quiet."
- "everyone's watching the wrong thing"

DO NOT sound like this (banned phrases):
- "indicating bullish bias"
- "technical score"
- "composite score"
- "RSI showing oversold conditions"
- "narrative strength is moderate"
- "the market phase is consolidation"
- "bullish/bearish token ratio"
- "it seems", "I think", "in my view"
- Any phrase that sounds like a report summary

TRANSLATE signals to human English:
- RSI below 35 → "price has been beaten down hard"
- RSI above 70 → "momentum is stretched — latecomers are still buying"
- MACD bullish crossover → "momentum is flipping positive"
- Price above all MAs → "structure is clean"
- High volume + price up → "real buying pressure, not a fake move"
- Narrative vs price divergence → "the story is loud but price isn't moving — something's off"

GOAL: Make someone who doesn't know what RSI is understand the market situation instantly, while still giving real analysts something to think about.

HARD LIMIT: The entire tweet must be under 278 characters total. Count carefully.`;

// ─── Helpers de traducción de señales ─────────────────────────────────────────

function interpretRSI(rsi) {
  if (!rsi) return null;
  if (rsi < 30) return `RSI at ${rsi.toFixed(0)} — sellers are exhausted, price has been beaten down hard`;
  if (rsi < 40) return `RSI at ${rsi.toFixed(0)} — price is weak but not yet at capitulation`;
  if (rsi < 55) return `RSI at ${rsi.toFixed(0)} — neutral, no clear momentum either way`;
  if (rsi < 65) return `RSI at ${rsi.toFixed(0)} — momentum building, buyers in control`;
  if (rsi < 75) return `RSI at ${rsi.toFixed(0)} — strong momentum but getting stretched`;
  return `RSI at ${rsi.toFixed(0)} — momentum is overextended, latecomers are still buying`;
}

function interpretMACD(macd) {
  if (!macd) return null;
  const m = String(macd).toLowerCase();
  if (m.includes('bullish') || m.includes('positive')) return 'momentum flipping positive';
  if (m.includes('bearish') || m.includes('negative')) return 'momentum rolling over';
  if (m.includes('neutral') || m.includes('flat')) return 'momentum flat — no conviction either way';
  return `MACD: ${macd}`;
}

function interpretMATrend(trend) {
  if (!trend) return null;
  const t = String(trend).toLowerCase().replace(/_/g, ' ');
  if (t.includes('strong bull') || t.includes('above all')) return 'price is above all key moving averages — structure is clean';
  if (t.includes('bull')) return 'price is above key averages — uptrend intact';
  if (t.includes('strong bear') || t.includes('below all')) return 'price is below all key moving averages — structure is broken';
  if (t.includes('bear')) return 'price is below key averages — downtrend in play';
  return 'moving averages are mixed — no clear trend yet';
}

function interpretVolume(volumeTrend) {
  if (!volumeTrend) return null;
  const v = String(volumeTrend).toLowerCase();
  if (v.includes('spike') || v.includes('surge') || v.includes('high')) return 'volume spiking — real conviction behind the move';
  if (v.includes('declin') || v.includes('low') || v.includes('weak')) return 'volume is fading — move lacks conviction';
  if (v.includes('above avg') || v.includes('above average')) return 'volume above average — buyers are showing up';
  return null;
}

function interpretBreakout(breakout) {
  if (!breakout || !breakout.type) return null;
  const type = String(breakout.type).toLowerCase().replace(/_/g, ' ');
  const pct = breakout.pctAbove ? ` by ${breakout.pctAbove.toFixed(1)}%` : '';
  if (type.includes('bull') || type.includes('up') || type.includes('above')) {
    return `breaking out${pct} above a key level — this is where shorts get squeezed`;
  }
  if (type.includes('bear') || type.includes('down') || type.includes('below')) {
    return `breaking down${pct} below support — this is where longs get trapped`;
  }
  return null;
}

function interpretMarketPhase(phase) {
  const p = String(phase).toLowerCase().replace(/_/g, ' ');
  if (p.includes('bull') || p.includes('up')) return 'sector is in full bull mode';
  if (p.includes('bear') || p.includes('down')) return 'sector is in a downtrend';
  if (p.includes('consolidat')) return 'sector is coiling — waiting for the next move';
  if (p.includes('recovery')) return 'sector is recovering off lows';
  if (p.includes('distribut')) return 'sector looks like it\'s being distributed';
  return p;
}

// ─── Generadores por tipo ──────────────────────────────────────────────────────

/**
 * Genera tweet de insight de mercado
 */
async function generateMarketInsightTweet(fusionData) {
  const { macroSignals, tokens } = fusionData;
  const top = tokens[0];
  const runner = macroSignals.topGainers?.[0];
  const laggard = macroSignals.topLosers?.[0];
  const totalTokens = (macroSignals.bullishTokenCount || 0) + (macroSignals.bearishTokenCount || 0);
  const bullPct = totalTokens > 0 ? Math.round((macroSignals.bullishTokenCount / totalTokens) * 100) : 0;

  const prompt = `Write ONE market insight tweet about the AI crypto sector right now.

SITUATION:
- Sector is ${interpretMarketPhase(macroSignals.marketPhase)}
- ${bullPct}% of AI tokens are up in the last 24h (${macroSignals.bullishTokenCount} up, ${macroSignals.bearishTokenCount} down)
- Average move across the sector: ${macroSignals.avgChange24h > 0 ? '+' : ''}${macroSignals.avgChange24h}% in 24h
- Dominant narrative right now: "${macroSignals.dominantNarrative}"
- Market mood: ${macroSignals.overallSentiment}
- Biggest winner 24h: ${runner?.symbol || 'N/A'} (${runner?.change24h?.toFixed(1) || 'N/A'}%)
- Biggest loser 24h: ${laggard?.symbol || 'N/A'} (${laggard?.change24h?.toFixed(1) || 'N/A'}%)
- Leading AI token right now: ${top?.symbol || 'N/A'} at ${formatPrice(top?.currentPrice)}

TWEET STRUCTURE:
Line 1 (Hook): Something sharp about what's actually happening in the sector — not a summary, a read.
Line 2 (Insight): One specific data point from above, explained in plain English. What's the contrast or tension?
Line 3 (Take): What does this mean? Who's right? Who gets trapped if this continues?

Return ONLY the tweet text. Max 278 characters total. Use line breaks between sections.`;

  return callGPT(prompt, TWEET_TYPES.MARKET_INSIGHT);
}

/**
 * Genera tweet de análisis técnico
 */
async function generateTechnicalTweet(fusionData) {
  const { tokens } = fusionData;
  const techInsight = fusionData.contentInsights?.technicalInsight;

  const focusToken = tokens.find(t => t.symbol === techInsight?.focusToken) || tokens[0];
  if (!focusToken) return null;

  const rsiRead    = interpretRSI(focusToken.rsi);
  const macdRead   = interpretMACD(focusToken.macd);
  const maRead     = interpretMATrend(focusToken.maTrend);
  const volRead    = interpretVolume(focusToken.volumeTrend?.label);
  const brkRead    = interpretBreakout(focusToken.breakout);

  // Build signal summary in plain English
  const signals = [rsiRead, macdRead, maRead, volRead, brkRead].filter(Boolean);
  const signalSummary = signals.slice(0, 3).join(' | ');

  const direction = focusToken.technicalBias?.toLowerCase();
  const biasPlain = direction?.includes('bull') ? 'setup leans bullish'
    : direction?.includes('bear') ? 'setup leans bearish'
    : 'setup is mixed — no clear edge';

  const prompt = `Write ONE technical analysis tweet about ${focusToken.symbol} (${focusToken.name}).

PRICE ACTION:
- Price: ${formatPrice(focusToken.currentPrice)} — ${focusToken.change24h >= 0 ? 'up' : 'down'} ${Math.abs(focusToken.change24h || 0).toFixed(1)}% in 24h
- Overall setup: ${biasPlain}
- Key signals: ${signalSummary || 'signals are mixed'}
${brkRead ? `- Structure note: ${brkRead}` : ''}

TWEET STRUCTURE:
Line 1 (Hook): One punchy observation about ${focusToken.symbol}'s price action or structure. Make someone stop scrolling.
Line 2 (Insight): Explain what the key signal is in plain English. No jargon. What's the market actually doing?
Line 3 (Take): What does this mean for people watching this token? Is this a trap or an opportunity?

Return ONLY the tweet text. Max 278 characters total. Use line breaks between sections. Do NOT use words like "technical score", "composite score", "RSI showing", "indicating bullish bias".`;

  return callGPT(prompt, TWEET_TYPES.TECHNICAL_ANALYSIS);
}

/**
 * Genera tweet de insight narrativo
 */
async function generateNarrativeTweet(fusionData) {
  const { narrativeSummary, aiNarrativeAnalysis, macroSignals } = fusionData;

  const topTokens   = narrativeSummary?.mostMentionedTokens?.slice(0, 3).join(', ') || 'N/A';
  const emerging    = narrativeSummary?.emergingTerms?.slice(0, 4).join(', ')        || 'N/A';
  const aiRead      = aiNarrativeAnalysis?.overallNarrativeAssessment               || '';
  const keyInsight  = aiNarrativeAnalysis?.keyInsights?.[0]                         || '';
  const alertTopic  = aiNarrativeAnalysis?.emergingNarrativeAlert?.topic;
  const alertConf   = aiNarrativeAnalysis?.emergingNarrativeAlert?.confidence;

  const prompt = `Write ONE narrative insight tweet about what crypto Twitter is really talking about right now in AI tokens.

WHAT'S HAPPENING ON CT:
- Most discussed right now: ${topTokens}
- Terms gaining traction in last 12h: ${emerging}
- Dominant narrative: "${macroSignals.dominantNarrative}" — sentiment is ${macroSignals.overallSentiment}
- Analyst read: ${aiRead}
- Key signal from the discourse: ${keyInsight}
${alertTopic ? `- Something new is emerging: "${alertTopic}" (confidence: ${alertConf})` : ''}

TWEET STRUCTURE:
Line 1 (Hook): What's the tension between what people are saying and what's actually happening? Lead with that.
Line 2 (Insight): What is the crowd focused on? Is the narrative ahead of the price or lagging behind it?
Line 3 (Take): What does this narrative shift mean? Who's early? Who's late?

Return ONLY the tweet text. Max 278 characters total. Use line breaks between sections. Sound like an insider reading the room, not a report.`;

  return callGPT(prompt, TWEET_TYPES.NARRATIVE_INSIGHT);
}

/**
 * Genera tweet contrarian
 */
async function generateContrarianTweet(fusionData) {
  const { contentInsights, tokens, macroSignals } = fusionData;
  const insight    = contentInsights?.contrarianInsight;
  const divergences = fusionData.topDivergences || [];
  const focusToken = insight?.focusToken
    ? tokens.find(t => t.symbol === insight.focusToken)
    : null;

  // Build divergence context in plain English
  const divSummary = divergences
    .slice(0, 2)
    .map(d => d.divergence?.description || '')
    .filter(Boolean)
    .join(' / ');

  const tokenContext = focusToken
    ? `${focusToken.symbol} is ${focusToken.change24h >= 0 ? 'up' : 'down'} ${Math.abs(focusToken.change24h || 0).toFixed(1)}% while the narrative says ${macroSignals.overallSentiment}`
    : '';

  const prompt = `Write ONE contrarian tweet about AI crypto markets. Push back on the consensus view.

WHAT THE CROWD THINKS:
- Dominant view: "${macroSignals.dominantNarrative}" narrative is ${macroSignals.narrativeStrength}
- Crowd sentiment: ${macroSignals.overallSentiment}
- Market phase: ${interpretMarketPhase(macroSignals.marketPhase)}

WHAT THE DATA ACTUALLY SHOWS:
${insight?.headline ? `- Contrarian signal: ${insight.headline}` : ''}
${insight?.dataPoints?.slice(0, 3).join('\n') || ''}
${divSummary ? `- Divergence: ${divSummary}` : ''}
${tokenContext ? `- Price reality: ${tokenContext}` : ''}

TWEET STRUCTURE:
Line 1 (Hook): State what everyone believes — then immediately challenge it. Create tension.
Line 2 (Insight): What does the data actually show that contradicts the consensus? Be specific.
Line 3 (Take): What's the non-obvious read here? Who's going to be wrong?

Return ONLY the tweet text. Max 278 characters total. Use line breaks. Be sharp and confident. Don't hedge.`;

  return callGPT(prompt, TWEET_TYPES.CONTRARIAN);
}

/**
 * Genera tweet de pensamiento sistémico
 */
async function generateSystemTweet(fusionData) {
  const { contentInsights, macroSignals, narrativeSummary, aiNarrativeAnalysis } = fusionData;

  const emerging  = narrativeSummary?.emergingTerms?.slice(0, 3).join(', ') || '';
  const aiRead    = aiNarrativeAnalysis?.overallNarrativeAssessment || '';
  const dataPoints = contentInsights?.systemInsight?.dataPoints?.slice(0, 2).join(' / ') || '';

  const prompt = `Write ONE systems-level tweet about the bigger picture in decentralized AI infrastructure.

MACRO CONTEXT:
- Sector structure: ${interpretMarketPhase(macroSignals.marketPhase)}
- The narrative dominating: "${macroSignals.dominantNarrative}"
- What's emerging on the edges: ${emerging || 'nothing notable yet'}
- Bigger picture read: ${aiRead}
${dataPoints ? `- Structural signals: ${dataPoints}` : ''}

TWEET STRUCTURE:
Line 1 (Hook): Zoom out. What's the structural thing happening that most people are missing? Make it feel important.
Line 2 (Insight): What's the underlying dynamic — not the price, the structure. What's being built or broken?
Line 3 (Take): Why does this matter 6 months from now? What's the implication most people aren't seeing?

Return ONLY the tweet text. Max 278 characters total. Use line breaks. Sound like someone who's been watching this space for years, not someone reacting to today's candle.`;

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
  const bullPct = Math.round(
    ((macroSignals.bullishTokenCount || 0) /
      Math.max(1, (macroSignals.bullishTokenCount || 0) + (macroSignals.bearishTokenCount || 0))) * 100
  );

  const prompt = `Write a Twitter thread analyzing the AI crypto sector for ${date}. Sound like a top crypto operator sharing a real-time market read — not a report.

MARKET SITUATION:
Sector: ${interpretMarketPhase(macroSignals.marketPhase)}
${bullPct}% of AI tokens are up in the last 24h
Average move: ${macroSignals.avgChange24h > 0 ? '+' : ''}${macroSignals.avgChange24h}% across the sector
Dominant narrative: "${macroSignals.dominantNarrative}"
Mood: ${macroSignals.overallSentiment}

TOP AI TOKENS (plain English):
${topTokens.map(t => {
  const rsi = interpretRSI(t.rsi);
  const dir = t.change24h >= 0 ? 'up' : 'down';
  return `- ${t.symbol}: ${formatPrice(t.currentPrice)}, ${dir} ${Math.abs(t.change24h || 0).toFixed(1)}% | ${rsi || ''} | setup: ${t.technicalBias || 'mixed'}`;
}).join('\n')}

NARRATIVE:
Most discussed: ${narrativeSummary?.mostMentionedTokens?.join(', ')}
Emerging terms: ${narrativeSummary?.emergingTerms?.join(', ')}
Key insight: ${aiNarrativeAnalysis?.keyInsights?.[0] || ''}

DIVERGENCES / CONTRARIAN:
${fusionData.topDivergences?.map(d => d.divergence?.description).filter(Boolean).join('\n') || 'none notable'}

Generate a Twitter thread as a JSON array. Each tweet max 270 characters. Hook → data → analysis → narrative → contrarian → synthesis. Each tweet is a standalone punch, not a report chapter.

Format:
[
  {"tweet": "Hook tweet — the one line that makes someone stop scrolling and read the thread", "type": "hook"},
  {"tweet": "Market overview — what's actually moving and what's not, in plain English", "type": "market"},
  {"tweet": "Best technical setup in the sector right now — no jargon, just the read", "type": "technical"},
  {"tweet": "What CT is saying vs what price is doing — the narrative tension", "type": "narrative"},
  {"tweet": "The non-obvious read — what most people are getting wrong right now", "type": "contrarian"},
  {"tweet": "The bigger picture — what this all means 3-6 months from now", "type": "synthesis"}
]

Rules: No emojis. No hashtags. No report language. Max 270 chars per tweet. Sound like a person, not a bot.`;

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
        temperature: 0.65,
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
    { type: TWEET_TYPES.MARKET_INSIGHT,    generator: generateMarketInsightTweet },
    { type: TWEET_TYPES.TECHNICAL_ANALYSIS, generator: generateTechnicalTweet },
    { type: TWEET_TYPES.NARRATIVE_INSIGHT,  generator: generateNarrativeTweet },
  ];

  // Agregar contrarian o system thinking aleatoriamente
  if (Math.random() > 0.5) {
    tweetTypes.push({ type: TWEET_TYPES.CONTRARIAN,     generator: generateContrarianTweet });
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
          scheduledFor: null,
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
      ? `\n\nCRITICAL: Your previous response was too long. This time you MUST write UNDER ${MAX_CHAR} characters total (including line breaks). Count every character carefully before responding.`
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
          temperature: attempt > 1 ? 0.4 : 0.65,
          max_tokens: 300,
        });
        return completion.choices[0].message.content.trim();
      },
      { label: `callGPT(${tweetType})`, ...config.retry }
    );

    // Limpiar comillas envolventes si las hay
    const text = response.replace(/^["']|["']$/g, '').trim();

    if (text.length <= MAX_CHAR) {
      if (attempt > 1) {
        log.info(`Tweet regenerado OK en intento ${attempt} (${text.length} chars)`);
      }
      return text;
    }

    log.warn(`Tweet demasiado largo en intento ${attempt}: ${text.length} chars > ${MAX_CHAR}. Regenerando...`);
  }

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
