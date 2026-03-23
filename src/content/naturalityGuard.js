'use strict';

/**
 * naturalityGuard.js
 *
 * Prevents the bot from sounding like a performance-optimized machine.
 * Ensures ~25% of tweets feel like real-time observations, not structured reports.
 *
 * Tweet modes:
 *   optimized    — hook-first, structured, strategy-driven
 *   balanced     — concrete insight, moderate structure
 *   observational — spontaneous, real-time feel, less formatted
 *
 * Rules:
 * 1. Over any rolling 8-tweet window: at least 2 must be 'observational'.
 * 2. No more than 3 consecutive 'optimized' tweets.
 * 3. Rhythm varies: short punchy tweet must follow every 2 long-form tweets.
 * 4. Certain phrases flag over-optimization and trigger reclassification.
 */

const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('NaturalityGuard');

// ─── Patterns that signal a robotic / over-optimized tweet ───────────────────

const ROBOTIC_PATTERNS = [
  /^(key (level|signal|insight|data)|watch (for|this)|important:|note:|update:)/i,
  /\b(bullish confirmation|bearish breakdown|support holds|resistance breaks)\b/i,
  /\b(thread below|🧵|1\/|2\/|3\/)\b/i,  // thread indicators mid-single-tweet
  /\b(alpha|gem|100x|moon|aping|WAGMI|NGMI)\b/i,
  /\b(very interesting|worth noting|this is huge|don't sleep on)\b/i,
  /\[(data|signal|insight|alert|update)\]/i,
];

const OBSERVATIONAL_SIGNALS = [
  /\b(noticing|been watching|just saw|interesting that|weird that|funny how)\b/i,
  /\b(earlier today|right now|as of this (hour|morning|write)|at the moment)\b/i,
  /\b(been thinking|starting to feel|getting the sense|seems like)\b/i,
  /\b(quietly|slowly|gradually|under the surface)\b/i,
];

// ─── Tweet classifier ─────────────────────────────────────────────────────────

/**
 * Classify a tweet as 'optimized', 'balanced', or 'observational'.
 * @param {string} text
 * @returns {'optimized' | 'balanced' | 'observational'}
 */
function classifyTweet(text) {
  if (!text) return 'balanced';

  const roboticCount      = ROBOTIC_PATTERNS.filter(p => p.test(text)).length;
  const observationalCount = OBSERVATIONAL_SIGNALS.filter(p => p.test(text)).length;

  // Length heuristic: very short tweets tend to feel more natural
  const wordCount = text.split(/\s+/).length;
  const isShort   = wordCount <= 25;

  if (observationalCount >= 1 || (isShort && roboticCount === 0)) {
    return 'observational';
  }
  if (roboticCount >= 2) {
    return 'optimized';
  }
  return 'balanced';
}

// ─── Window analysis ──────────────────────────────────────────────────────────

/**
 * Analyze a recent tweet history window for naturality distribution.
 * @param {string[]} recentTexts - last N tweet texts (oldest→newest)
 * @returns {{ modes: object, needsObservational: boolean, consecutiveOptimized: number }}
 */
function analyzeWindow(recentTexts = []) {
  const window8 = recentTexts.slice(-8);
  const modes   = { optimized: 0, balanced: 0, observational: 0 };

  for (const text of window8) {
    const mode = classifyTweet(text);
    modes[mode]++;
  }

  // Count consecutive 'optimized' at the tail
  let consecutiveOptimized = 0;
  for (let i = recentTexts.length - 1; i >= 0; i--) {
    if (classifyTweet(recentTexts[i]) === 'optimized') {
      consecutiveOptimized++;
    } else {
      break;
    }
  }

  const needsObservational = modes.observational < Math.max(1, Math.floor(window8.length * 0.25));

  return { modes, needsObservational, consecutiveOptimized };
}

// ─── Pre-publish check ────────────────────────────────────────────────────────

/**
 * Validate a proposed tweet against naturality rules.
 * Returns { pass, mode, reason, suggestion }.
 *
 * @param {string} text          - proposed tweet text
 * @param {string[]} recentTexts - last 8 published tweets
 * @returns {{ pass: boolean, mode: string, reason: string|null, suggestion: string|null }}
 */
function checkNaturality(text, recentTexts = []) {
  const mode   = classifyTweet(text);
  const window = analyzeWindow(recentTexts);

  // Rule 1: If window needs observational and this isn't one → soft reject
  if (window.needsObservational && mode === 'optimized') {
    log.warn(`NaturalityGuard: optimized tweet blocked — window needs observational (${window.modes.observational}/8)`);
    return {
      pass:       false,
      mode,
      reason:     `Window has only ${window.modes.observational} observational tweets (min 2 per 8). This tweet is too structured.`,
      suggestion: 'Rewrite as a real-time observation. Remove hook structure. Start mid-thought.',
    };
  }

  // Rule 2: No more than 3 consecutive optimized
  if (window.consecutiveOptimized >= 3 && mode === 'optimized') {
    log.warn(`NaturalityGuard: ${window.consecutiveOptimized} consecutive optimized tweets — forcing variation`);
    return {
      pass:       false,
      mode,
      reason:     `${window.consecutiveOptimized} consecutive structured tweets. Pattern too mechanical.`,
      suggestion: 'Write a short, unstructured take. 1-2 lines. No hook formula.',
    };
  }

  log.info(`NaturalityGuard: pass — mode=${mode} | consecutive_optimized=${window.consecutiveOptimized}`);
  return { pass: true, mode, reason: null, suggestion: null };
}

// ─── Rhythm check ─────────────────────────────────────────────────────────────

/**
 * Check if a short tweet is needed after several long ones.
 * @param {string[]} recentTexts
 * @returns {boolean} true if next tweet should be short (<= 180 chars)
 */
function needsShortTweet(recentTexts = []) {
  const last3 = recentTexts.slice(-3);
  const longCount = last3.filter(t => t.split(/\s+/).length > 35).length;
  return longCount >= 2;
}

/**
 * Build a naturality-aware instruction to append to the GPT prompt.
 * @param {string[]} recentTexts
 * @param {string} tweetType
 * @returns {string}
 */
function buildNaturalityInstruction(recentTexts = [], tweetType = '') {
  const window = analyzeWindow(recentTexts);
  const short  = needsShortTweet(recentTexts);
  const parts  = [];

  if (window.needsObservational) {
    parts.push(
      'NATURALITY: Write this as a real-time observation, not a structured insight. ' +
      'Start mid-thought. No hook formula. Sound like you just noticed something.'
    );
  }

  if (window.consecutiveOptimized >= 2) {
    parts.push(
      'RHYTHM: Vary the tone from the last few tweets. Less structure, more direct.'
    );
  }

  if (short) {
    parts.push(
      'LENGTH: Keep this under 180 characters. Short and sharp — one clean line.'
    );
  }

  if (parts.length === 0) {
    parts.push('TONE: Natural, operator-style voice. Not a report, not a formula.');
  }

  return parts.join('\n');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  classifyTweet,
  analyzeWindow,
  checkNaturality,
  needsShortTweet,
  buildNaturalityInstruction,
};
