'use strict';

const OpenAI = require('openai');
const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const { formatPrice, formatPct, formatVolume, todayISO } = require('../utils/helpers');

// ─── Adaptive systems ─────────────────────────────────────────────────────────
// Loaded with try/catch so the bot keeps running even if these modules fail
let _getCurrentStrategy   = () => ({ preferred_types: [], tone: '', focus_tokens: [], hook_style: 'tension', structure: 'standard' });
let _buildInjection       = () => '';
let _getLatestHint        = () => null;
let _selectHookHint       = () => '';
let _getStructureInst     = () => '';
let _diversityCheck       = () => ({ ok: true });
let _applyDiversityRules  = (t) => t;
let _trackTweet           = () => {};
let _loadRecentCache      = () => [];

// Phase 2 modules
let _buildDailyMix            = (strategy, slots) => [];
let _buildNaturalityInst      = () => '';
let _checkNaturality          = () => ({ pass: true });
let _signalRelevanceGate      = () => ({ pass: true });
let _buildSignalInstruction   = () => '';

try {
  const fl = require('../performance/feedbackLoop');
  _getCurrentStrategy = fl.getCurrentStrategy;
} catch (e) { /* feedbackLoop not yet available */ }

try {
  const po = require('../performance/promptOptimizer');
  _buildInjection = po.buildInjectionForPrompt;
} catch (e) { /* promptOptimizer not yet available */ }

try {
  const la = require('../performance/liveAdjuster');
  _getLatestHint = la.getLatestHintForType;
} catch (e) { /* liveAdjuster not yet available */ }

try {
  const vp = require('./viralPatterns');
  _selectHookHint      = vp.selectHookHint;
  _getStructureInst    = vp.getStructureInstruction;
  _diversityCheck      = vp.diversityCheck;
  _applyDiversityRules = vp.applyDiversityRules;
  _trackTweet          = vp.trackTweetForDiversity;
  _loadRecentCache     = vp.loadRecentTweetCache;
} catch (e) { /* viralPatterns not yet available */ }

try {
  const cmc = require('./contentMixController');
  _buildDailyMix = cmc.buildDailyMix;
} catch (e) { /* contentMixController not yet available */ }

try {
  const ng = require('./naturalityGuard');
  _buildNaturalityInst = ng.buildNaturalityInstruction;
  _checkNaturality     = ng.checkNaturality;
} catch (e) { /* naturalityGuard not yet available */ }

try {
  const sr = require('./signalRelevance');
  _signalRelevanceGate    = sr.signalRelevanceGate;
  _buildSignalInstruction = sr.buildSignalInstruction;
} catch (e) { /* signalRelevance not yet available */ }

// ─── Account identity (permanent, loaded once) ────────────────────────────────
let _identity = null;
function getIdentity() {
  if (_identity) return _identity;
  try {
    _identity = require('../config/accountIdentity.json');
  } catch {
    _identity = {};
  }
  return _identity;
}

function buildIdentityPrefix() {
  const id = getIdentity();
  if (!id.forbidden_traits) return '';
  const forbidden = (id.forbidden_traits || []).slice(0, 6).join(', ');
  const coreRules = (id.core_rules || []).slice(0, 3).join(' | ');
  return [
    `IDENTITY (permanent — never changes): ${id.tone || 'sharp, analytical, slightly contrarian'}`,
    `FORBIDDEN: ${forbidden}`,
    `CORE RULES: ${coreRules}`,
  ].join('\n');
}

const log = createModuleLogger('ContentGenerator');

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: config.openai.apiKey });
  return _openai;
}

// ─── Tipos de contenido ────────────────────────────────────────────────────────

const TWEET_TYPES = {
  MARKET_INSIGHT:      'market_insight',
  TECHNICAL_ANALYSIS:  'technical_analysis',
  NARRATIVE_INSIGHT:   'narrative_insight',
  CONTRARIAN:          'contrarian',
  SYSTEM_THINKING:     'system_thinking',
  DIVERGENCE:          'divergence',
  FUNDAMENTAL_INSIGHT: 'fundamental_insight',
};

// ─── System prompt base ────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are a top crypto operator. Sharp. Contrarian. In the market every day.

STRUCTURE (always 3 lines, always this order):
1. HOOK — one line. Stops the scroll. A tension or observation, not a summary.
2. INSIGHT — one signal in plain English. What's the market actually doing?
3. TAKE — your read. Implicit. Leave something unsaid. Make them think.

COMPRESSION RULES (non-negotiable):
- Write a draft, then cut 30% of the words. Keep the punch, kill the filler.
- Every word must earn its place. If it explains too much, cut it.
- Short > complete. Impact > explanation. Implied > stated.
- Do NOT explain the take fully. Let the reader connect the last dot.
- 3 lines. No more. Tight line breaks. No dense blocks.

VOICE:
- "price isn't breaking — that's the signal"
- "narrative loud. price quiet."
- "everyone's watching the wrong thing"
- "this is where people get trapped"
- "momentum building. nobody noticed."

BANNED (instant disqualify):
- "indicating bullish bias" / "technical score" / "composite score"
- "narrative strength" / "market phase" / "token ratio"
- "it seems" / "I think" / "in my view"
- Any sentence that reads like a report line

SIGNAL TRANSLATION:
- RSI < 35 → "price beaten down hard"
- RSI > 70 → "momentum stretched — latecomers still buying"
- MACD bullish → "momentum flipping"
- Above all MAs → "structure clean"
- Volume spike → "real conviction behind the move"
- Narrative ≠ price → "story is loud. price isn't listening."

HARD LIMIT: Under 278 characters total. Count before submitting.`;

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

  const prompt = `Write ONE market insight tweet. 3 lines. Tight.

DATA:
- Sector: ${interpretMarketPhase(macroSignals.marketPhase)}
- ${bullPct}% of AI tokens up in 24h
- Avg move: ${macroSignals.avgChange24h > 0 ? '+' : ''}${macroSignals.avgChange24h}%
- Narrative: "${macroSignals.dominantNarrative}" — mood: ${macroSignals.overallSentiment}
- Top mover: ${runner?.symbol || 'N/A'} ${runner?.change24h?.toFixed(1) || 'N/A'}% | Worst: ${laggard?.symbol || 'N/A'} ${laggard?.change24h?.toFixed(1) || 'N/A'}%
- Leading token: ${top?.symbol || 'N/A'} at ${formatPrice(top?.currentPrice)}

Line 1 (Hook): Sharp read on the sector. Not a summary — a real observation. Tension or contrast.
Line 2 (Insight): One data point, plain English. What's the market doing that people aren't saying out loud?
Line 3 (Take): Your read. Keep something implicit. Don't over-explain. Leave them thinking.

Write it. Then cut 30% of the words. Return ONLY the final tweet. Max 278 chars.`;

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

  // Decision layer: extract support/resistance for conditional framing
  const support    = focusToken.breakout?.support;
  const resistance = focusToken.breakout?.resistance;
  const decisionCtx = support && resistance
    ? `Key levels: support ${formatPrice(support)} / resistance ${formatPrice(resistance)}`
    : support
      ? `Key level: support at ${formatPrice(support)}`
      : resistance
        ? `Key level: resistance at ${formatPrice(resistance)}`
        : '';

  const prompt = `Write ONE price action tweet on ${focusToken.symbol}. 3 lines. Cut every unnecessary word.

DATA:
- ${formatPrice(focusToken.currentPrice)} — ${focusToken.change24h >= 0 ? 'up' : 'down'} ${Math.abs(focusToken.change24h || 0).toFixed(1)}% in 24h
- Setup: ${biasPlain}
- Signals: ${signalSummary || 'mixed — no clear edge'}
${brkRead ? `- Structure: ${brkRead}` : ''}
${decisionCtx ? `- ${decisionCtx}` : ''}

Line 1 (Hook): One sharp observation about ${focusToken.symbol} right now. What's the thing people aren't saying?
Line 2 (Insight): The key signal in plain English. No jargon. What's actually happening?
Line 3 (Decision): A conditional scenario using the key level. Use ONE of these frames:
  - "If [level] holds → [scenario]"
  - "If [level] breaks → [scenario]"
  - "Watch for [condition] — then [implication]"
  Do NOT give buy/sell advice. Frame it as what to watch, not what to do.

Write it. Then cut 30% of the words. Return ONLY the final tweet. Max 278 chars.`;

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

  const prompt = `Write ONE narrative tweet on what CT is actually saying about AI tokens. 3 lines. Compress hard.

SIGNAL:
- Most discussed: ${topTokens}
- Gaining traction: ${emerging}
- Narrative: "${macroSignals.dominantNarrative}" — ${macroSignals.overallSentiment}
- Read: ${aiRead}
- Key signal: ${keyInsight}
${alertTopic ? `- Emerging: "${alertTopic}"` : ''}

Line 1 (Hook): The gap between what people are saying and what's actually happening. Lead with the tension.
Line 2 (Insight): Is the narrative ahead of price or lagging? One clear signal from above.
Line 3 (Take): Who's early. Who's late. Keep it implied — don't state it directly.

Write it. Then cut 30% of the words. Return ONLY the final tweet. Max 278 chars.`;

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

  const prompt = `Write ONE contrarian tweet. Challenge the consensus. 3 lines. No hedging. Compress hard.

CROWD THINKS:
- "${macroSignals.dominantNarrative}" — ${macroSignals.overallSentiment}
- Sector: ${interpretMarketPhase(macroSignals.marketPhase)}

DATA SAYS:
${insight?.headline ? `- ${insight.headline}` : ''}
${insight?.dataPoints?.slice(0, 2).join('\n') || ''}
${divSummary ? `- ${divSummary}` : ''}
${tokenContext ? `- ${tokenContext}` : ''}

Line 1 (Hook): What everyone believes — immediately challenged. One sentence, maximum tension.
Line 2 (Insight): What the data actually shows. Be specific. Make it sting.
Line 3 (Take): The non-obvious read. Don't explain it fully. Let them sit with it.

Write it. Then cut 30% of the words. Return ONLY the final tweet. Max 278 chars.`;

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

  const prompt = `Write ONE macro tweet on decentralized AI infrastructure. Zoom out. 3 lines. Compress hard.

CONTEXT:
- Sector: ${interpretMarketPhase(macroSignals.marketPhase)}
- Dominant narrative: "${macroSignals.dominantNarrative}"
- Emerging: ${emerging || 'nothing yet'}
- Read: ${aiRead}
${dataPoints ? `- Signal: ${dataPoints}` : ''}

Line 1 (Hook): The structural thing most people are missing. Not the price — the bigger picture.
Line 2 (Insight): What's being built or broken right now. The underlying dynamic, not the candle.
Line 3 (Take): The implication 6 months from now. Implied, not stated. One thing unsaid.

Write it. Then cut 30% of the words. Return ONLY the final tweet. Max 278 chars.`;

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

Generate a Twitter thread as a JSON array. Each tweet max 270 characters. Each tweet is a standalone punch — short, compressed, real-time. No dense lines. No report language. Write each tweet, then cut 30% of the words.

Format:
[
  {"tweet": "One line. The thing that makes someone stop and read the whole thread.", "type": "hook"},
  {"tweet": "What's actually moving and what isn't. Tension in plain English.", "type": "market"},
  {"tweet": "Best setup in the sector. No jargon. Just the read.", "type": "technical"},
  {"tweet": "CT vs price. The gap between the story and what's happening.", "type": "narrative"},
  {"tweet": "What most people are getting wrong. Implicit. Leave something unsaid.", "type": "contrarian"},
  {"tweet": "The bigger picture. One implication. Short. Make them think.", "type": "synthesis"}
]

Rules: No emojis. No hashtags. Max 270 chars per tweet. Short sentences. Every word earns its place.`;

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
      [TWEET_TYPES.MARKET_INSIGHT]:      generateMarketInsightTweet,
      [TWEET_TYPES.TECHNICAL_ANALYSIS]:  generateTechnicalTweet,
      [TWEET_TYPES.NARRATIVE_INSIGHT]:   generateNarrativeTweet,
      [TWEET_TYPES.CONTRARIAN]:          generateContrarianTweet,
      [TWEET_TYPES.SYSTEM_THINKING]:     generateSystemTweet,
      [TWEET_TYPES.FUNDAMENTAL_INSIGHT]: async (fd) => {
        const { generateFundamentalTweet } = require('../fundamental/fundamentalAnalysis');
        return generateFundamentalTweet(fd);
      },
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

  // Load strategy and build 6-slot mix via contentMixController
  const dailyStrategy = _getCurrentStrategy();
  const avoid         = dailyStrategy.avoid_types || [];

  const generatorMap = {
    [TWEET_TYPES.MARKET_INSIGHT]:      { type: TWEET_TYPES.MARKET_INSIGHT,      generator: generateMarketInsightTweet },
    [TWEET_TYPES.TECHNICAL_ANALYSIS]:  { type: TWEET_TYPES.TECHNICAL_ANALYSIS,  generator: generateTechnicalTweet     },
    [TWEET_TYPES.NARRATIVE_INSIGHT]:   { type: TWEET_TYPES.NARRATIVE_INSIGHT,   generator: generateNarrativeTweet     },
    [TWEET_TYPES.CONTRARIAN]:          { type: TWEET_TYPES.CONTRARIAN,          generator: generateContrarianTweet    },
    [TWEET_TYPES.SYSTEM_THINKING]:     { type: TWEET_TYPES.SYSTEM_THINKING,     generator: generateSystemTweet        },
    [TWEET_TYPES.FUNDAMENTAL_INSIGHT]: {
      type: TWEET_TYPES.FUNDAMENTAL_INSIGHT,
      generator: async (fd) => {
        const { generateFundamentalTweet } = require('../fundamental/fundamentalAnalysis');
        return generateFundamentalTweet(fd);
      },
    },
  };

  // ── Use contentMixController for stable 6-slot daily structure ────────────
  const targetSlots  = config.content.tweetsPerDay || 6;
  let mixTypes       = _buildDailyMix(dailyStrategy, targetSlots);

  // Fall back to manual list if contentMixController isn't available yet
  if (!mixTypes.length) {
    mixTypes = [
      TWEET_TYPES.MARKET_INSIGHT,
      TWEET_TYPES.TECHNICAL_ANALYSIS,
      TWEET_TYPES.NARRATIVE_INSIGHT,
      TWEET_TYPES.CONTRARIAN,
      TWEET_TYPES.FUNDAMENTAL_INSIGHT,
      TWEET_TYPES.MARKET_INSIGHT,
    ].slice(0, targetSlots);
  }

  // Apply diversity rules to avoid repeating types from recent days
  const recentCache = _loadRecentCache();
  const baseTypes   = _applyDiversityRules(mixTypes, recentCache);

  const tweetTypes = baseTypes
    .filter(t => !avoid.includes(t))
    .map(t => generatorMap[t])
    .filter(Boolean);

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

  // ── Load adaptive injections ──────────────────────────────────────────────
  const strategy        = _getCurrentStrategy();
  const perfInjection   = _buildInjection(tweetType);
  const liveHint        = _getLatestHint(tweetType);
  const hookHint        = _selectHookHint(tweetType, null, strategy);
  const structureInst   = _getStructureInst(strategy.structure || 'standard');

  // Phase 2 injections
  const recentCachePhase2 = _loadRecentCache();
  const recentTextsPhase2 = recentCachePhase2.map(c => c.content);
  const naturalityInst    = _buildNaturalityInst(recentTextsPhase2, tweetType);
  const signalInst        = _buildSignalInstruction(tweetType);
  const identityPrefix    = buildIdentityPrefix();

  // Build the adaptive prefix to inject into the user prompt
  const adaptiveParts = [identityPrefix, perfInjection, hookHint, structureInst, naturalityInst, signalInst];
  if (strategy.tone) {
    adaptiveParts.push(`TONE FOR THIS TWEET: ${strategy.tone}`);
  }
  if (strategy.focus_tokens?.length) {
    adaptiveParts.push(`PREFERRED TOKENS (if data supports it): ${strategy.focus_tokens.slice(0, 3).join(', ')}`);
  }
  if (liveHint) {
    adaptiveParts.push(`LIVE ADJUSTER HINT (from recent underperformance): ${liveHint}`);
  }

  const adaptivePrefix = adaptiveParts.filter(Boolean).join('\n');

  for (let attempt = 1; attempt <= MAX_REGEN_ATTEMPTS; attempt++) {
    const extraInstruction = attempt > 1
      ? `\n\nCRITICAL: Your previous response was too long. This time you MUST write UNDER ${MAX_CHAR} characters total (including line breaks). Count every character carefully before responding.`
      : '';

    const fullPrompt = adaptivePrefix
      ? `${adaptivePrefix}\n\n--- PROMPT ---\n${userPrompt}${extraInstruction}`
      : userPrompt + extraInstruction;

    const response = await withRetry(
      async () => {
        const openai = getOpenAI();
        const completion = await openai.chat.completions.create({
          model: config.openai.model,
          messages: [
            { role: 'system', content: BASE_SYSTEM_PROMPT },
            { role: 'user', content: fullPrompt },
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

    if (text.length > MAX_CHAR) {
      log.warn(`Tweet demasiado largo en intento ${attempt}: ${text.length} chars > ${MAX_CHAR}. Regenerando...`);
      continue;
    }

    // ── Signal relevance gate ────────────────────────────────────────────
    const signalCheck = _signalRelevanceGate(text, tweetType);
    if (!signalCheck.pass && attempt < MAX_REGEN_ATTEMPTS) {
      log.warn(`SignalRelevance FAIL (attempt ${attempt}): regenerating — ${signalCheck.regenerateWith?.substring(0, 80)}`);
      continue;
    }

    // ── Naturality check ─────────────────────────────────────────────────
    const naturalityCheck = _checkNaturality(text, recentTextsPhase2);
    if (!naturalityCheck.pass && attempt < MAX_REGEN_ATTEMPTS) {
      log.warn(`NaturalityGuard FAIL (attempt ${attempt}): ${naturalityCheck.reason?.substring(0, 80)}`);
      continue;
    }

    if (attempt > 1) {
      log.info(`Tweet regenerado OK en intento ${attempt} (${text.length} chars)`);
    }

    // ── Diversity check before accepting ────────────────────────────────
    const recentCache   = _loadRecentCache();
    const recentTexts   = recentCache.map(c => c.content);
    const divResult     = _diversityCheck(text, recentTexts);
    if (!divResult.ok && attempt < MAX_REGEN_ATTEMPTS) {
      log.warn(`Diversity check failed: ${divResult.reason} — regenerating`);
      continue;
    }

    // Track this tweet for future diversity checks
    _trackTweet(text, tweetType);
    return text;
  }

  log.error(`Tweet tipo ${tweetType} superó todos los intentos. Descartando.`);
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
  TWEET_TYPES,
};
