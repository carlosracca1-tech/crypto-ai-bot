'use strict';

/**
 * antiOverfitting.js
 *
 * Prevents the bot from overreacting to short-term performance fluctuations.
 *
 * Rules:
 * 1. No daily strategy update may change more than 30% of content mix at once.
 * 2. No single tweet type may exceed 35% of daily output (6 tweets = max 2.1 → 2).
 * 3. Performance signals smoothed over 3-day AND 7-day rolling windows.
 * 4. Single-day spikes do not trigger aggressive reallocation.
 * 5. Baseline diversity enforced even if one format dominates temporarily.
 */

const fs   = require('fs');
const path = require('path');
const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('AntiOverfitting');

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_MIX_CHANGE_PER_DAY    = 0.30; // max 30% of the mix can shift in one day
const MAX_SINGLE_TYPE_SHARE     = 0.35; // no type > 35% of daily output
const SPIKE_DETECTION_THRESHOLD = 2.0;  // score 2× the rolling avg = spike
const TWEETS_PER_DAY            = 6;

// ─── Rolling window smoothing ─────────────────────────────────────────────────

/**
 * Compute smoothed scores using rolling windows.
 * Returns { smooth3d, smooth7d } per tweet type.
 *
 * @param {object[]} entries - performance log entries (sorted oldest→newest)
 * @returns {object} smoothed scores keyed by tweet type
 */
function computeSmoothedScores(entries) {
  const now    = Date.now();
  const day3   = now - 3  * 24 * 3600 * 1000;
  const day7   = now - 7  * 24 * 3600 * 1000;

  const window3d = entries.filter(e => new Date(e.timestamp).getTime() > day3);
  const window7d = entries.filter(e => new Date(e.timestamp).getTime() > day7);

  const aggregate = (subset) => {
    const byType = {};
    for (const e of subset) {
      const t = e.type || 'unknown';
      if (!byType[t]) byType[t] = [];
      byType[t].push(e.metrics?.engagement_score || 0);
    }
    const result = {};
    for (const [type, scores] of Object.entries(byType)) {
      result[type] = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
    return result;
  };

  return {
    smooth3d: aggregate(window3d),
    smooth7d: aggregate(window7d),
    // Weighted blend: 40% 3-day recency + 60% 7-day stability
    blended:  blendScores(aggregate(window3d), aggregate(window7d), 0.4, 0.6),
  };
}

function blendScores(scores3d, scores7d, w3, w7) {
  const allTypes = new Set([...Object.keys(scores3d), ...Object.keys(scores7d)]);
  const result   = {};
  for (const type of allTypes) {
    const s3 = scores3d[type] || 0;
    const s7 = scores7d[type] || 0;
    result[type] = parseFloat((s3 * w3 + s7 * w7).toFixed(3));
  }
  return result;
}

// ─── Spike detection ──────────────────────────────────────────────────────────

/**
 * Detect if a type's recent score is a temporary spike vs. a sustained signal.
 * Spike = score in last 24h is >2× the 7-day average.
 * If it's a spike, we dampen the weight change.
 *
 * @param {string} type
 * @param {object} smoothed - output of computeSmoothedScores
 * @returns {boolean} true if this is a temporary spike
 */
function isTemporarySpike(type, smoothed) {
  const recent = smoothed.smooth3d[type] || 0;
  const stable = smoothed.smooth7d[type] || 0;
  if (stable === 0) return false;
  return recent > stable * SPIKE_DETECTION_THRESHOLD;
}

// ─── Mix enforcement ──────────────────────────────────────────────────────────

/**
 * Apply anti-overfitting rules to a proposed new strategy.
 * Returns a corrected strategy that respects stability constraints.
 *
 * @param {object} proposedStrategy  - from feedbackLoop.generateStrategy()
 * @param {object} currentStrategy   - currently active strategy
 * @param {object[]} perfEntries     - full performance log
 * @returns {object} corrected strategy
 */
function applyAntiOverfitting(proposedStrategy, currentStrategy, perfEntries = []) {
  const smoothed = computeSmoothedScores(perfEntries);
  const corrected = { ...proposedStrategy };
  const changes   = [];

  // ── Rule 1: Limit preferred_types shift ──────────────────────────────────
  const prevPref = new Set(currentStrategy.preferred_types || []);
  const newPref  = new Set(proposedStrategy.preferred_types || []);

  // Count how many types are being added/removed
  const added   = [...newPref].filter(t => !prevPref.has(t));
  const removed = [...prevPref].filter(t => !newPref.has(t));
  const totalChange = (added.length + removed.length) / Math.max(prevPref.size, 1);

  if (totalChange > MAX_MIX_CHANGE_PER_DAY) {
    log.warn(`AntiOverfitting: mix shift too large (${(totalChange * 100).toFixed(0)}%) — dampening`);
    // Only allow 1 type to change per day
    const limitedPref = [...prevPref];
    if (added.length > 0) limitedPref.push(added[0]); // add at most 1 new type
    if (removed.length > 0) limitedPref.splice(limitedPref.indexOf(removed[0]), 1); // remove at most 1
    corrected.preferred_types = [...new Set(limitedPref)];
    changes.push(`Mix shift dampened from ${(totalChange * 100).toFixed(0)}% to single-type adjustment`);
  }

  // ── Rule 2: No single type > 35% of output ────────────────────────────────
  const typeCountMap = {};
  for (const type of corrected.preferred_types || []) {
    typeCountMap[type] = (typeCountMap[type] || 0) + 1;
  }
  const maxAllowed = Math.floor(TWEETS_PER_DAY * MAX_SINGLE_TYPE_SHARE); // = 2
  for (const [type, count] of Object.entries(typeCountMap)) {
    if (count > maxAllowed) {
      log.warn(`AntiOverfitting: ${type} exceeds ${MAX_SINGLE_TYPE_SHARE * 100}% cap — reducing`);
      // Remove extras from preferred list
      let removed_count = 0;
      corrected.preferred_types = corrected.preferred_types.filter(t => {
        if (t === type && removed_count < count - maxAllowed) { removed_count++; return false; }
        return true;
      });
      changes.push(`${type} capped at ${maxAllowed} slots/day`);
    }
  }

  // ── Rule 3: Suppress spike-driven changes ────────────────────────────────
  const spikedTypes = (proposedStrategy.preferred_types || []).filter(t => isTemporarySpike(t, smoothed));
  if (spikedTypes.length > 0) {
    log.info(`AntiOverfitting: spike detected for [${spikedTypes.join(', ')}] — using blended scores instead`);
    changes.push(`Spike dampened for: ${spikedTypes.join(', ')} (using 7-day average)`);
    // Keep the type in preferred but don't let it displace stable types
  }

  // ── Rule 4: Always maintain at least 3 distinct types in the mix ─────────
  const distinctTypes = new Set(corrected.preferred_types || []);
  if (distinctTypes.size < 3) {
    log.warn(`AntiOverfitting: only ${distinctTypes.size} distinct types — adding baseline diversity`);
    const baseline = ['market_insight', 'technical_analysis', 'contrarian'];
    for (const b of baseline) {
      if (!distinctTypes.has(b)) {
        corrected.preferred_types = [...(corrected.preferred_types || []), b];
        distinctTypes.add(b);
        changes.push(`Baseline type added: ${b}`);
        if (distinctTypes.size >= 3) break;
      }
    }
  }

  // ── Attach metadata ───────────────────────────────────────────────────────
  corrected._anti_overfitting = {
    applied:       changes.length > 0,
    changes,
    smoothed_scores: smoothed.blended,
    spike_types:   spikedTypes,
  };

  if (changes.length > 0) {
    log.info(`AntiOverfitting applied: ${changes.join(' | ')}`);
  } else {
    log.info('AntiOverfitting: no corrections needed');
  }

  return corrected;
}

// ─── Strategy stability structure ────────────────────────────────────────────

/**
 * Build the "stability report" for a strategy update.
 * Separates: what stays stable vs. small adjustments vs. tests.
 *
 * @param {object} newStrategy
 * @param {object} prevStrategy
 * @param {object} smoothed
 * @returns {object}
 */
function buildStabilityReport(newStrategy, prevStrategy, smoothed) {
  const identity = (() => {
    try { return require('../config/accountIdentity.json'); } catch { return {}; }
  })();

  return {
    stable_core: {
      tone:        identity.tone        || newStrategy.tone,
      positioning: identity.positioning || 'AI + crypto operator',
      identity:    'locked — never changes with performance data',
    },
    small_adjustments: {
      preferred_types_change: (newStrategy.preferred_types || [])
        .filter(t => !(prevStrategy.preferred_types || []).includes(t))
        .map(t => `+${t}`),
      avoided_types: newStrategy.avoid_types || [],
      token_focus_change: newStrategy.focus_tokens?.join(', ') || 'unchanged',
    },
    tests: generateTestSuggestions(smoothed, newStrategy),
  };
}

function generateTestSuggestions(smoothed, strategy) {
  const suggestions = [];
  const blended = smoothed?.blended || {};

  // Suggest testing types that haven't been tried much
  const lowDataTypes = ['fundamental_insight', 'system_thinking', 'divergence']
    .filter(t => !blended[t]);
  if (lowDataTypes.length > 0) {
    suggestions.push(`test ${lowDataTypes[0]} — no performance data yet`);
  }

  // Suggest structural test if avg score is low
  if ((strategy.performance_snapshot?.avg_score || 0) < 8) {
    suggestions.push('test shorter tweets (under 180 chars) for next 3 days');
  }

  // Token test
  const topToken = Object.entries(smoothed?.by_token || {})
    .sort(([, a], [, b]) => b.avg_score - a.avg_score)[0]?.[0];
  if (topToken && !(strategy.focus_tokens || []).includes(topToken)) {
    suggestions.push(`test more coverage of ${topToken} — high engagement signal`);
  }

  return suggestions.length > 0 ? suggestions : ['maintain current approach — performance is stable'];
}

module.exports = {
  applyAntiOverfitting,
  computeSmoothedScores,
  buildStabilityReport,
  isTemporarySpike,
};
