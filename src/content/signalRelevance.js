'use strict';

/**
 * signalRelevance.js
 *
 * Pre-publish gate: a tweet must answer at least TWO of:
 *   A. What is happening right now (observable fact, price action, on-chain)
 *   B. Why it matters (implication, consequence, structural significance)
 *   C. What to watch next (level, condition, upcoming catalyst)
 *
 * Additionally:
 *   - Tweets that only contain vague rhetorical questions are rejected
 *   - Tweets with zero forward-looking element (B or C) are rejected
 *   - Abstract observations without interpretation or implication are rejected
 *
 * If it fails, it is sent back for regeneration with a targeted hint.
 * This prevents content that sounds analytical but delivers no actual signal.
 */

const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('SignalRelevance');

// ─── Pattern banks ────────────────────────────────────────────────────────────

// A: What is happening
const HAPPENING_PATTERNS = [
  /\$[A-Z]{2,10}\s+(at|above|below|near|testing|holding|breaking|rejecting|reclaiming)/i,
  /\b(price action|volume|open interest|funding rate|dominance|TVL|dev activity|supply)\b/i,
  /\b(broke(n)?|breakout|breakdown|reclaim|rejection|flush|pump|dump|spike|drop|rally|correction)\b/i,
  /\b(\d+(\.\d+)?[kKmMbB]?)\s*(support|resistance|level|range|floor|ceiling)/i,
  /\b(on[- ]?chain|mempool|exchange (inflow|outflow)|whale|accumulation|distribution)\b/i,
  /\b(RSI|MACD|moving average|MA[0-9]+|EMA|Bollinger|volume profile|OI)\b/i,
  /\b(narrative|sector|rotation|correlation|decoupling|divergence)\b/i,
];

// B: Why it matters
const MATTERS_PATTERNS = [
  /\b(which means|this means|implication|signal(ing)?|suggest(ing)?|indicat(es|ing))\b/i,
  /\b(if (this|it) holds|if (price|it) breaks|watch (for|if)|conditional on)\b/i,
  /\b(historically|precedent|last time|compared to|relative to|vs\.?)\b/i,
  /\b(risk (is|becomes)|reward|asymmetric|setup|structure (is|shifts|changes))\b/i,
  /\b(market (is|has)|sentiment|positioning|crowded|consensus|expectation)\b/i,
  /\b(catalyst|driver|headwind|tailwind|pressure|demand|supply)\b/i,
  /\b(where (traps?|longs?|shorts?|traders?|latecomers?) (form|get|are))\b/i,
  /\b(trapped|squeezed|caught|wrecked|shaken out)\b/i,
  /\b(not confirming|not following|not backing|divergen(ce|t)|mismatch)\b/i,
  /\b(consensus|crowd|everyone|narrative)\b.*\b(wrong|missing|ahead|behind|late)\b/i,
];

// C: What to watch next
const WATCH_PATTERNS = [
  /\b(watch (for|if|this|that)|next (level|target|resistance|support|test|catalyst|move))\b/i,
  /\b(key (level|zone|test|date|event)|critical (level|point|test))\b/i,
  /\b(if (price|it|we) (holds|breaks|reclaims|loses|closes|fails))\b/i,
  /\b(eyes on|monitoring|tracking|waiting for|pending|upcoming)\b/i,
  /\b(target|invalidate(s|d)?|stop|entry|zone|confirm(ation)?)\b/i,
  /\b(this week|next (week|month|quarter)|into (the )?(weekend|Monday|close))\b/i,
  /\b(if (momentum|this|that|narrative|it) (doesn't|continues|fades|holds|flips|breaks))\b/i,
  /\b(fades?|reverses?|accelerates?|continues?|stalls?|confirms?)\b/i,
];

// ─── Vagueness detection ───────────────────────────────────────────────────────
// Patterns that indicate a tweet is abstract/rhetorical with no actionable content.
// A tweet that ONLY matches these (no happening/matters/watch) should be rejected.
const VAGUE_PATTERNS = [
  /^(everyone('s)?|the market|CT|people|traders|bulls?|bears?)\s+(is|are|has|have)\s+/i,
  /\?$/m,                                                       // ends with rhetorical question
  /\b(is anyone|does anyone|who('s| is)|but is|but are)\b/i,   // unanswered questions
  /\b(blinding|deafening|screaming|shouting|ignoring)\b/i,     // pure metaphor, no data
  /\b(sounds? (good|like|nice)|feels? (like|bullish|bearish))\b/i,
  /\b(everyone knows|no one (knows|is watching|sees))\b/i,
];

/**
 * Returns true if the tweet is purely vague — rhetorical questions,
 * abstract metaphors, no concrete data, no implication, no forward-look.
 */
function isVagueTweet(text, happening, matters, watchNext) {
  if (happening || matters || watchNext) return false; // has at least one real signal
  const vagueMatches = VAGUE_PATTERNS.filter(p => p.test(text)).length;
  return vagueMatches >= 2; // two or more vague markers and zero signal → reject
}

// ─── Core evaluator ───────────────────────────────────────────────────────────

/**
 * Score a tweet's signal relevance.
 * @param {string} text
 * @returns {{ score: number, dimensions: object, pass: boolean, reason: string|null }}
 */
function evaluateSignalRelevance(text) {
  if (!text || text.trim().length < 10) {
    return {
      score: 0,
      dimensions: { happening: false, matters: false, watchNext: false },
      pass: false,
      reason: 'Tweet is empty or too short to contain a signal.',
    };
  }

  const happening = HAPPENING_PATTERNS.some(p => p.test(text));
  const matters   = MATTERS_PATTERNS.some(p => p.test(text));
  const watchNext = WATCH_PATTERNS.some(p => p.test(text));

  const score = [happening, matters, watchNext].filter(Boolean).length;

  // Rule 1: Must score >= 2 (answer at least two of the three questions)
  // Rule 2: Must have at least one forward-looking element (matters OR watchNext)
  // Rule 3: Purely vague tweets (rhetorical questions, metaphors, no data) always fail
  const hasForwardLook = matters || watchNext;
  const vague          = isVagueTweet(text, happening, matters, watchNext);

  const pass   = score >= 2 && hasForwardLook && !vague;
  let reason   = null;

  if (!pass) {
    if (vague) {
      reason = 'Tweet is purely abstract — rhetorical questions and metaphors with no concrete signal.';
    } else if (!hasForwardLook) {
      reason = 'Tweet lacks forward-looking element: add interpretation (why it matters) or implication (what to watch).';
    } else {
      reason =
        'Tweet does not answer at least two of: what is happening, why it matters, what to watch. ' +
        'Add specific data, implication, or conditional framing.';
    }
  }

  log.info(`SignalRelevance: score=${score}/3 | happening=${happening} | matters=${matters} | watchNext=${watchNext} | pass=${pass}`);

  return {
    score,
    dimensions: { happening, matters, watchNext },
    pass,
    reason,
  };
}

// ─── Gate function ────────────────────────────────────────────────────────────

/**
 * Pre-publish gate. Returns pass/fail with regeneration instruction.
 * @param {string} text
 * @param {string} tweetType - used to calibrate strictness
 * @returns {{ pass: boolean, score: number, regenerateWith: string|null }}
 */
function signalRelevanceGate(text, tweetType = '') {
  const result = evaluateSignalRelevance(text);

  if (result.pass) {
    return { pass: true, score: result.score, regenerateWith: null };
  }

  // Build targeted regeneration instruction
  const missing = [];
  if (!result.dimensions.happening) missing.push('what is currently happening (price action, data point, on-chain fact)');
  if (!result.dimensions.matters)   missing.push('why it matters (implication, structural significance, conditional)');
  if (!result.dimensions.watchNext) missing.push('what to watch next (level, condition, upcoming catalyst)');

  // Detect if the tweet ended with a rhetorical question (common failure mode)
  const endsWithQuestion = /\?(\s*)$/.test(text.trim());
  const questionNote = endsWithQuestion
    ? ' Do NOT end with a rhetorical question — end with a concrete implication or conditional instead.'
    : '';

  const regenerateWith =
    `This tweet lacks depth. It needs at least TWO of these three layers — ` +
    `and MUST include at least one forward-looking element. ` +
    `Missing: ${missing.join('; ')}. ` +
    `Be specific — use token names, price levels, RSI values, or percentage moves. ` +
    `Replace vague statements with facts. Replace questions with observations or conditionals.` +
    questionNote;

  log.warn(`SignalRelevance FAIL (type=${tweetType}): ${result.reason}`);

  return { pass: false, score: result.score, regenerateWith };
}

/**
 * Build a signal-awareness instruction to prepend to the GPT prompt.
 * Used to bias generation toward passing the gate.
 *
 * @param {string} tweetType
 * @returns {string}
 */
function buildSignalInstruction(tweetType = '') {
  const base =
    'DEPTH REQUIREMENT (mandatory — tweets that fail this are regenerated):\n' +
    'Every tweet must answer at least TWO of these three questions:\n' +
    '  (A) OBSERVATION: What is happening right now — specific price action, data point, on-chain fact\n' +
    '  (B) INTERPRETATION: Why it matters — what this signal means, implication, structural read\n' +
    '  (C) IMPLICATION: What to watch or what happens next — level, condition, or scenario\n' +
    'MANDATORY: Must include (B) or (C) — pure observations without meaning or forward-look are rejected.\n' +
    'BANNED: Rhetorical questions as the final line. Vague metaphors with no data. ' +
    'Abstract statements that could apply to any market at any time.';

  const typeHints = {
    market_insight:      'Cover (A) + (B): what the sector is doing AND what that means for positioning.',
    technical_analysis:  'Cover (A) + (C): current price structure AND the conditional scenario (if X → Y).',
    fundamental_insight: 'Cover (A) + (B): on-chain or dev data AND why it changes the thesis.',
    narrative_insight:   'Cover (A) + (B): the narrative vs price gap AND who gets trapped.',
    contrarian:          'Cover (A) + (B) + (C): the data point that breaks consensus, why it matters, what fades if momentum fails.',
    callback:            'Cover (A) + (C): reference the prior setup AND what the next level or condition is.',
    system_thinking:     'Cover (B) + (C): structural implication AND the 6-month scenario.',
  };

  const hint = typeHints[tweetType] ? `\n${typeHints[tweetType]}` : '';
  return base + hint;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  evaluateSignalRelevance,
  signalRelevanceGate,
  buildSignalInstruction,
};
