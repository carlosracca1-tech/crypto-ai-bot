'use strict';

/**
 * viralPatterns.js
 *
 * Library of proven viral tweet structures, hooks, and patterns.
 * Every tweet passes through this module before generation.
 *
 * Integrates into contentGenerator.js:
 * - selectHook(tweetType, token, strategy)
 * - diversityCheck(content, recentTweets)
 * - applyDiversityRules(tweetTypes, recentTweets)
 */

const fs   = require('fs');
const path = require('path');
const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('ViralPatterns');

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR       = path.join(process.cwd(), 'data');
const RECENTS_FILE   = path.join(DATA_DIR, 'recent_tweets_diversity.json');

// ─── Hook libraries ───────────────────────────────────────────────────────────

const HOOKS = {
  // Contrarian hooks — create immediate tension
  contrarian: [
    'Most people are missing this.',
    'This move is not random.',
    'Everyone watching the wrong thing.',
    'This is where traders get trapped.',
    'The consensus is wrong — here\'s the data.',
    'CT pumping this. Price isn\'t listening.',
    'Narrative loud. Price quiet. That\'s the signal.',
  ],

  // Tension hooks — create "what happens next" urgency
  tension: [
    'This is the level that matters.',
    'Something is building here.',
    'The setup is getting interesting.',
    'Quiet accumulation. Nobody\'s noticing.',
    'Momentum is shifting.',
    'Volume tells the real story.',
  ],

  // Data shock hooks — lead with a surprising number
  data_shock: [
    '{token} moved {pct}% while everyone watched something else.',
    'Dev commits up {n}x in 4 weeks. Price doesn\'t know yet.',
    'Volume spike with no announcement. That\'s the tell.',
    '{n}% of AI tokens up. The market doesn\'t feel like it.',
    'RSI at {n}. Last time this happened: {context}.',
  ],

  // Question hooks — make people think
  question: [
    'Why is volume drying up while sentiment pumps?',
    'If the narrative is bullish, why isn\'t price moving?',
    'How do you trade a market that\'s right about the story but wrong about timing?',
    'What happens when the catalyst everyone is waiting for finally comes?',
  ],

  // Callback hooks — reference prior content
  callback: [
    'That level we flagged → now testing it.',
    'Earlier we noted the setup. Here\'s where it stands.',
    'Momentum building since our last note on this.',
    'The thesis is still intact. Here\'s the update.',
  ],
};

// ─── Structural templates ─────────────────────────────────────────────────────

const STRUCTURES = {
  standard: {
    description: '3 lines: Hook → Insight → Implied take',
    instruction: 'Line 1: Hook. Line 2: The data signal in plain English. Line 3: Your read — leave the last connection unsaid.',
  },
  short_punchy: {
    description: '2-3 very short lines, maximum compression',
    instruction: 'Write it, then cut 40% of the words. Each line under 60 chars. Punch every word. No soft phrasing.',
  },
  thread_teaser: {
    description: 'Single tweet that teases a thread',
    instruction: 'First line creates curiosity. Second line hints at what\'s inside. Third line is the implicit invitation to read on.',
  },
  conditional: {
    description: 'If/then conditional framing',
    instruction: 'Build around a specific level or condition. "If X holds → Y". "If X breaks → Z". Do not give buy/sell advice.',
  },
};

// ─── Diversity tracking ───────────────────────────────────────────────────────

/**
 * Load the last 20 tweets for diversity checking.
 */
function loadRecentTweetCache() {
  try {
    if (!fs.existsSync(RECENTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(RECENTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Save a new tweet to the diversity cache.
 */
function trackTweetForDiversity(content, type) {
  const entries = loadRecentTweetCache();
  entries.unshift({ content, type, timestamp: new Date().toISOString() });
  const trimmed = entries.slice(0, 20);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RECENTS_FILE, JSON.stringify(trimmed, null, 2));
}

// ─── Diversity check ──────────────────────────────────────────────────────────

const FORBIDDEN_REPEATS = [
  // Generic openings that get repetitive
  /^(the market|market is|price is|btc is|eth is)/i,
  /^(looking at|looking into|let\'s look)/i,
  /^(important|very important|key)/i,
];

const STRUCTURAL_FINGERPRINTS = [
  /narrative (loud|quiet)/i,
  /nobody('s| is) (noticing|talking|watching)/i,
  /that\'s the (signal|tell|move)/i,
  /most people (are|don\'t)/i,
];

/**
 * Check if new content is too similar to recent tweets.
 * @param {string} newContent
 * @param {string[]} recentContents - array of recent tweet texts
 * @returns {{ ok: boolean, reason: string|null }}
 */
function diversityCheck(newContent, recentContents = []) {
  const newLower    = newContent.toLowerCase();
  const recentLower = recentContents.map(t => t.toLowerCase());

  // Check for forbidden generic openings
  for (const pattern of FORBIDDEN_REPEATS) {
    if (pattern.test(newContent)) {
      return { ok: false, reason: `Generic opening: "${newContent.split('\n')[0].substring(0, 40)}..."` };
    }
  }

  // Check for repeated structural fingerprints
  for (const fingerprint of STRUCTURAL_FINGERPRINTS) {
    if (fingerprint.test(newLower)) {
      const alreadyUsed = recentLower.some(r => fingerprint.test(r));
      if (alreadyUsed) {
        return { ok: false, reason: `Structural pattern already used: ${fingerprint}` };
      }
    }
  }

  // Check for very similar first lines
  const newFirstLine = newContent.split('\n')[0].toLowerCase();
  for (const recent of recentLower) {
    const recentFirstLine = recent.split('\n')[0];
    // Simple similarity: if 6+ consecutive words match, it's too similar
    const newWords    = newFirstLine.split(/\s+/);
    const recentWords = recentFirstLine.split(/\s+/);
    let maxMatchRun   = 0;
    let currentRun    = 0;
    for (const word of newWords) {
      if (recentWords.includes(word) && word.length > 3) {
        currentRun++;
        maxMatchRun = Math.max(maxMatchRun, currentRun);
      } else {
        currentRun = 0;
      }
    }
    if (maxMatchRun >= 5) {
      return { ok: false, reason: 'First line too similar to recent tweet' };
    }
  }

  return { ok: true, reason: null };
}

/**
 * Ensure tweet type diversity in the daily plan.
 * Given a list of tweet types for today, check the last 3 days and
 * suggest reordering to avoid same-type back-to-back days.
 */
function applyDiversityRules(plannedTypes, recentTweets = []) {
  const recentTypes = recentTweets.slice(0, 6).map(t => t.type);

  // If last 2 tweets are the same type as first planned, rotate
  const firstType = plannedTypes[0];
  const lastTwoTypes = recentTypes.slice(0, 2);
  if (lastTwoTypes.every(t => t === firstType) && plannedTypes.length > 1) {
    log.info(`Diversity: rotating ${firstType} to avoid triple repeat`);
    const rotated = [...plannedTypes.slice(1), plannedTypes[0]];
    return rotated;
  }

  return plannedTypes;
}

// ─── Hook selection ───────────────────────────────────────────────────────────

/**
 * Select the most appropriate hook for a tweet, based on type and strategy.
 * Returns a hint string to inject into the GPT prompt.
 *
 * @param {string} tweetType
 * @param {string|null} token
 * @param {object} strategy - current strategy from feedbackLoop
 * @returns {string}
 */
function selectHookHint(tweetType, token, strategy = {}) {
  const hookStyle = strategy.hook_style || 'tension';
  const hookLib   = HOOKS[hookStyle] || HOOKS.tension;

  // Pick a random hook from the library for this style
  const hook = hookLib[Math.floor(Math.random() * hookLib.length)];

  // Token substitution
  const resolved = hook
    .replace('{token}', token || 'the token')
    .replace('{pct}', (Math.random() * 8 + 2).toFixed(1))
    .replace('{n}', Math.floor(Math.random() * 50 + 10))
    .replace('{context}', 'it was a turning point');

  return `HOOK INSPIRATION (do NOT copy verbatim — use as structural inspiration):\n"${resolved}"`;
}

/**
 * Get the structure instruction for a given structure style.
 */
function getStructureInstruction(structureStyle = 'standard') {
  const struct = STRUCTURES[structureStyle] || STRUCTURES.standard;
  return `STRUCTURE: ${struct.instruction}`;
}

module.exports = {
  selectHookHint,
  getStructureInstruction,
  diversityCheck,
  applyDiversityRules,
  trackTweetForDiversity,
  loadRecentTweetCache,
  HOOKS,
  STRUCTURES,
};
