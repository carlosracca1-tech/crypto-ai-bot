'use strict';

/**
 * feedbackLoop.js
 *
 * Reads the performance log and generates DAILY STRATEGIC ADJUSTMENTS.
 * Produces a "current_strategy" object that contentGenerator reads before
 * every tweet to adapt tone, type, focus tokens and structure.
 *
 * Strategy is persisted to data/current_strategy.json
 */

const fs   = require('fs');
const path = require('path');
const { createModuleLogger } = require('../utils/logger');
const { getLatestPatterns, loadPerformanceLog } = require('./performanceEngine');

const log = createModuleLogger('FeedbackLoop');

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR        = path.join(process.cwd(), 'data');
const STRATEGY_FILE   = path.join(DATA_DIR, 'current_strategy.json');
const ADJUSTMENT_LOG  = path.join(DATA_DIR, 'adjustment_log.json');

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_STRATEGY = {
  preferred_types:  ['market_insight', 'technical_analysis', 'contrarian'],
  avoid_types:      [],
  tone:             'sharp, data-driven, slightly contrarian',
  focus_tokens:     ['BTC', 'ETH', 'SOL', 'TAO', 'RNDR'],
  avoid_tokens:     [],
  structure:        'standard', // 'standard' | 'short_punchy' | 'thread_teaser'
  hook_style:       'tension',  // 'tension' | 'question' | 'data_shock' | 'contrarian'
  generated_at:     new Date().toISOString(),
  reason:           'Default strategy — no performance data yet',
};

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadStrategy() {
  try {
    if (!fs.existsSync(STRATEGY_FILE)) return { ...DEFAULT_STRATEGY };
    return JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf8'));
  } catch {
    return { ...DEFAULT_STRATEGY };
  }
}

function saveStrategy(strategy) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(strategy, null, 2));
}

function logAdjustment(adjustment) {
  try {
    let entries = [];
    if (fs.existsSync(ADJUSTMENT_LOG)) {
      entries = JSON.parse(fs.readFileSync(ADJUSTMENT_LOG, 'utf8'));
    }
    entries.unshift({ ...adjustment, timestamp: new Date().toISOString() });
    entries = entries.slice(0, 90); // keep 90 days
    fs.writeFileSync(ADJUSTMENT_LOG, JSON.stringify(entries, null, 2));
  } catch (err) {
    log.warn(`Could not log adjustment: ${err.message}`);
  }
}

// ─── Strategy generator ───────────────────────────────────────────────────────

/**
 * Derive tone string from performance patterns.
 * If contrarian is the best type → inject aggressive tone.
 * If narrative is best → inject storytelling tone.
 */
function deriveTone(patterns) {
  const best = patterns.best_type;

  if (best === 'contrarian')          return 'sharp, aggressive, challenges consensus';
  if (best === 'technical_analysis')  return 'precise, data-first, conditional framing';
  if (best === 'narrative_insight')   return 'macro-aware, storytelling, reads the crowd';
  if (best === 'fundamental_insight') return 'research-driven, developer-focused, long-term';
  if (best === 'market_insight')      return 'real-time, direct, momentum-aware';
  return 'sharp, data-driven, slightly contrarian';
}

/**
 * Derive hook style from what content resonates.
 */
function deriveHookStyle(patterns) {
  const best = patterns.best_type;
  if (best === 'contrarian')          return 'contrarian'; // "Most people are wrong about this"
  if (best === 'technical_analysis')  return 'data_shock'; // "RSI at 28. Nobody's talking."
  if (best === 'narrative_insight')   return 'question';   // "Why is volume drying up while CT pumps?"
  return 'tension';
}

/**
 * Compute preferred/avoid types from patterns.
 * - Top 2 types by avg score → preferred
 * - Worst type (if score < 50% of best) → avoid temporarily
 */
function deriveTypeAllocation(byType) {
  const sorted = Object.entries(byType)
    .filter(([, v]) => v.count >= 2)
    .sort(([, a], [, b]) => b.avg_score - a.avg_score);

  if (!sorted.length) return { preferred: [], avoid: [] };

  const preferred = sorted.slice(0, 2).map(([t]) => t);
  const bestScore = sorted[0]?.[1]?.avg_score || 0;
  const avoid     = sorted
    .filter(([, v]) => bestScore > 0 && v.avg_score < bestScore * 0.4)
    .map(([t]) => t);

  return { preferred, avoid };
}

/**
 * Core: generate a new strategy based on current performance patterns.
 */
function generateStrategy(patterns) {
  if (!patterns || patterns.total_tweets < 5) {
    log.info('Not enough data for strategy adjustment — using defaults');
    return { ...DEFAULT_STRATEGY, reason: `Insufficient data (${patterns?.total_tweets || 0} tweets tracked)` };
  }

  const { preferred, avoid } = deriveTypeAllocation(patterns.by_type || {});
  const tone       = deriveTone(patterns);
  const hookStyle  = deriveHookStyle(patterns);
  const focusTokens = patterns.top_tokens?.length >= 2
    ? patterns.top_tokens.slice(0, 5)
    : DEFAULT_STRATEGY.focus_tokens;

  // Determine structure based on avg engagement
  // High engagement → keep current structure; low → try shorter
  const structure = patterns.avg_score < 5 ? 'short_punchy' : 'standard';

  const changes = [];
  if (preferred.length) changes.push(`Prioritizing ${preferred.join(', ')} content`);
  if (avoid.length)     changes.push(`Reducing ${avoid.join(', ')} (underperforming)`);
  if (focusTokens.join(',') !== DEFAULT_STRATEGY.focus_tokens.join(','))
    changes.push(`Focus tokens: ${focusTokens.join(', ')}`);

  const strategy = {
    preferred_types:  preferred.length ? preferred : DEFAULT_STRATEGY.preferred_types,
    avoid_types:      avoid,
    tone,
    hook_style:       hookStyle,
    focus_tokens:     focusTokens,
    avoid_tokens:     [],
    structure,
    generated_at:     new Date().toISOString(),
    reason:           changes.length ? changes.join(' | ') : 'No significant changes needed',
    performance_snapshot: {
      best_type:        patterns.best_type,
      worst_type:       patterns.worst_type,
      avg_score:        patterns.avg_score,
      trend:            patterns.trend,
      best_time_window: patterns.best_time_window,
    },
  };

  return strategy;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run daily feedback loop.
 * Reads performance data → generates new strategy → saves → returns adjustments.
 */
async function runFeedbackLoop() {
  log.info('Running daily feedback loop...');

  try {
    const patterns  = getLatestPatterns();
    const prevStrat = loadStrategy();
    const newStrat  = generateStrategy(patterns);

    saveStrategy(newStrat);

    // Build adjustment diff for logging/email
    const adjustment = {
      date:             new Date().toISOString().split('T')[0],
      previous_strategy: {
        preferred_types: prevStrat.preferred_types,
        tone:            prevStrat.tone,
        focus_tokens:    prevStrat.focus_tokens,
      },
      new_strategy: {
        preferred_types: newStrat.preferred_types,
        avoid_types:     newStrat.avoid_types,
        tone:            newStrat.tone,
        focus_tokens:    newStrat.focus_tokens,
        structure:       newStrat.structure,
      },
      performance: patterns.performance_snapshot || {
        best_type:  patterns.best_type,
        avg_score:  patterns.avg_score,
        trend:      patterns.trend,
      },
      reason: newStrat.reason,
    };

    logAdjustment(adjustment);

    log.info(`Strategy updated: ${newStrat.reason}`);
    log.info(`  Preferred types: ${newStrat.preferred_types.join(', ')}`);
    log.info(`  Tone: ${newStrat.tone}`);
    log.info(`  Focus tokens: ${newStrat.focus_tokens.join(', ')}`);

    return { strategy: newStrat, patterns, adjustment };
  } catch (err) {
    log.error(`Feedback loop error: ${err.message}`);
    return { strategy: loadStrategy(), patterns: null, adjustment: null };
  }
}

/**
 * Get the currently active strategy (used by contentGenerator on every run).
 */
function getCurrentStrategy() {
  return loadStrategy();
}

/**
 * Get last N daily adjustments (for email report).
 */
function getAdjustmentHistory(n = 7) {
  try {
    if (!fs.existsSync(ADJUSTMENT_LOG)) return [];
    const entries = JSON.parse(fs.readFileSync(ADJUSTMENT_LOG, 'utf8'));
    return entries.slice(0, n);
  } catch {
    return [];
  }
}

module.exports = {
  runFeedbackLoop,
  getCurrentStrategy,
  generateStrategy,
  getAdjustmentHistory,
};
