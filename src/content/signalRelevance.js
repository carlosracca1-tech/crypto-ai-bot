'use strict';

/**
 * signalRelevance.js
 *
 * Pre-publish gate: a tweet must answer at least ONE of:
 *   A. What is happening right now (observable fact, price action, on-chain)
 *   B. Why it matters (implication, consequence, structural significance)
 *   C. What to watch next (level, condition, upcoming catalyst)
 *
 * If it fails all three, it is rejected or sent back for regeneration.
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
];

// C: What to watch next
const WATCH_PATTERNS = [
  /\b(watch (for|if|this|that)|next (level|target|resistance|support|test|catalyst|move))\b/i,
  /\b(key (level|zone|test|date|event)|critical (level|point|test))\b/i,
  /\b(if (price|it|we) (holds|breaks|reclaims|loses|closes|fails))\b/i,
  /\b(eyes on|monitoring|tracking|waiting for|pending|upcoming)\b/i,
  /\b(target|invalidate(s|d)?|stop|entry|zone|confirm(ation)?)\b/i,
  /\b(this week|next (week|month|quarter)|into (the )?(weekend|Monday|close))\b/i,
];

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

  const pass   = score >= 1;
  let reason   = null;

  if (!pass) {
    reason =
      'Tweet does not answer: what is happening, why it matters, or what to watch. ' +
      'Add at least one concrete signal, implication, or conditional.';
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

  const regenerateWith =
    `This tweet lacks a signal. Missing: ${missing.join('; ')}. ` +
    `Rewrite to include at least one of these. Lead with the fact or condition. ` +
    `Be specific — use actual numbers, levels, or named tokens.`;

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
    'SIGNAL REQUIREMENT: This tweet must answer at least one of:\n' +
    '  (A) What is happening right now — specific price action, data, on-chain fact\n' +
    '  (B) Why it matters — implication, structure, conditional framing\n' +
    '  (C) What to watch next — level, condition, or upcoming catalyst\n' +
    'Generic observations without any of these will be rejected.';

  const typeHints = {
    market_insight:      'Focus on (A): what price or market structure is doing right now.',
    technical_analysis:  'Focus on (A) + (C): current levels and what breaks next.',
    fundamental_insight: 'Focus on (A) + (B): on-chain or dev data and its implication.',
    narrative_insight:   'Focus on (B): why the current narrative is or isn\'t supported by price.',
    contrarian:          'Focus on (B): what the consensus is missing and why the read is wrong.',
    callback:            'Focus on (A) + (C): reference a prior call and what happens from here.',
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
