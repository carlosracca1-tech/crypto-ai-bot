'use strict';

/**
 * contentMixController.js
 *
 * Defines and enforces the stable daily content mix for 6 tweets/day.
 * Performance optimization can shift weights, but cannot abandon the structure.
 *
 * Default daily mix:
 *   1. market_insight       — market structure read
 *   2. technical_analysis   — price action + levels
 *   3. fundamental_insight  — developer/on-chain/supply
 *   4. narrative_insight    — CT narrative vs price
 *   5. contrarian           — challenges the consensus
 *   6. callback / close     — references previous content OR market close
 */

const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('ContentMixController');

// ─── Canonical daily mix ──────────────────────────────────────────────────────

const DEFAULT_DAILY_MIX = [
  { slot: 1, type: 'market_insight',      label: 'Market Structure',   weight: 1.0, required: true  },
  { slot: 2, type: 'technical_analysis',  label: 'Technical Analysis', weight: 1.0, required: true  },
  { slot: 3, type: 'fundamental_insight', label: 'Fundamental',        weight: 1.0, required: false },
  { slot: 4, type: 'narrative_insight',   label: 'Narrative',          weight: 1.0, required: false },
  { slot: 5, type: 'contrarian',          label: 'Contrarian',         weight: 1.0, required: false },
  { slot: 6, type: 'market_insight',      label: 'Close / Callback',   weight: 1.0, required: false },
];

// ─── Thread schedule ──────────────────────────────────────────────────────────

const THREAD_SCHEDULE = {
  fundamental: {
    dayOfWeek: 1,          // Monday
    description: 'Deep fundamental analysis of a core watchlist token',
  },
  technical_narrative: {
    dayOfWeek: 4,          // Thursday
    description: 'Technical + narrative thread on sector structure',
  },
  opportunistic: {
    trigger: 'major_narrative_spike', // detected by narrativeDetector
    description: 'Thread when a major AI crypto narrative emerges unexpectedly',
    min_signal_strength: 0.75,
  },
};

// ─── Mix controller ───────────────────────────────────────────────────────────

/**
 * Build the final tweet type sequence for the day.
 * Applies strategy preferences but preserves structural balance.
 *
 * @param {object} strategy   - current strategy from feedbackLoop
 * @param {number} totalSlots - number of tweets today (default 6)
 * @returns {string[]} ordered list of tweet types
 */
function buildDailyMix(strategy = {}, totalSlots = 6) {
  const preferred = strategy.preferred_types || [];
  const avoided   = strategy.avoid_types     || [];

  // Start from the canonical mix
  const mix = DEFAULT_DAILY_MIX.slice(0, totalSlots).map(slot => ({ ...slot }));

  // Apply strategy preferences: boost weight of preferred types
  for (const slot of mix) {
    if (preferred.includes(slot.type)) {
      slot.weight = 1.3; // slight boost — doesn't replace required slots
    }
    if (avoided.includes(slot.type) && !slot.required) {
      slot.weight = 0.4; // reduce but don't eliminate
    }
  }

  // For non-required slots: pick best-weighted available type
  // Slot 5 (contrarian) and 6 (close/callback) can flex
  const flexSlots = [4, 5]; // 0-indexed slots 5 and 6
  for (const idx of flexSlots) {
    if (idx >= mix.length) continue;
    const slot = mix[idx];
    if (slot.required) continue;

    // If the strategy strongly prefers a different type, swap this slot
    const strongPref = preferred.find(t =>
      !mix.slice(0, idx).map(s => s.type).includes(t) &&
      !avoided.includes(t)
    );
    if (strongPref && slot.weight < 1.0) {
      log.info(`ContentMix: replacing slot ${idx + 1} (${slot.type}) with preferred ${strongPref}`);
      slot.type  = strongPref;
      slot.label = `Strategy: ${strongPref}`;
    }
  }

  const result = mix.map(s => s.type);
  log.info(`Daily mix: ${result.join(' → ')}`);
  return result;
}

/**
 * Validate that a proposed type sequence doesn't violate mix rules.
 * Returns { valid, violations }.
 */
function validateMix(types) {
  const violations = [];
  const counts     = {};

  for (const t of types) {
    counts[t] = (counts[t] || 0) + 1;
  }

  // No type > 35% of total (max 2 of 6)
  const maxAllowed = Math.ceil(types.length * 0.35);
  for (const [type, count] of Object.entries(counts)) {
    if (count > maxAllowed) {
      violations.push(`${type} appears ${count}× (max ${maxAllowed})`);
    }
  }

  // Must have at least one market_insight or technical_analysis
  const hasMarketBase = types.includes('market_insight') || types.includes('technical_analysis');
  if (!hasMarketBase) {
    violations.push('No market_insight or technical_analysis — at least one required');
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Determine if today should have an opportunistic thread.
 * @param {object} narrativeData - from narrativeDetector
 * @returns {boolean}
 */
function shouldRunOpportunisticThread(narrativeData) {
  if (!narrativeData) return false;
  const strength = narrativeData.dominantNarrative?.strength || 0;
  return strength >= THREAD_SCHEDULE.opportunistic.min_signal_strength;
}

/**
 * Get today's thread type based on day of week.
 * @returns {'fundamental' | 'technical_narrative' | null}
 */
function getTodayThreadType() {
  const dayOfWeek = new Date().getUTCDay(); // 0 = Sunday
  if (dayOfWeek === THREAD_SCHEDULE.fundamental.dayOfWeek)          return 'fundamental';
  if (dayOfWeek === THREAD_SCHEDULE.technical_narrative.dayOfWeek)  return 'technical_narrative';
  return null;
}

module.exports = {
  buildDailyMix,
  validateMix,
  shouldRunOpportunisticThread,
  getTodayThreadType,
  DEFAULT_DAILY_MIX,
  THREAD_SCHEDULE,
};
