'use strict';

/**
 * Daily Health Check
 *
 * Agrega estadísticas del día desde todos los módulos y envía
 * un email de status a las 23:00 ART.
 */

const fs   = require('fs');
const path = require('path');
const { createModuleLogger }            = require('../utils/logger');
const { sendHealthReport, sendGrowthIntelligenceReport, sendPerformanceDegradationAlert } = require('./emailAlerts');
const { getErrorStats }                 = require('./errorMonitor');

// Adaptive systems — loaded gracefully
let getLatestPatterns  = () => ({});
let getCurrentStrategy = () => ({});
let getAdjustmentHistory = () => [];

try { getLatestPatterns    = require('../performance/performanceEngine').getLatestPatterns;    } catch (e) {}
try { getCurrentStrategy   = require('../performance/feedbackLoop').getCurrentStrategy;        } catch (e) {}
try { getAdjustmentHistory = require('../performance/feedbackLoop').getAdjustmentHistory;      } catch (e) {}

const log = createModuleLogger('HealthCheck');

// ─── Lectura de datos del día ──────────────────────────────────────────────────

function todayART() {
  // UTC-3
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  return d.toISOString().split('T')[0];
}

function readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getPipelineStats() {
  const runsFile = path.join(process.cwd(), 'data', 'pipeline_runs.json');
  const data     = readJSON(runsFile);
  if (!data?.runs) return { tweetsPosted: 0, tweetsScheduled: 0, tweets: [], errors: [] };

  const today = todayART();
  const todayRuns = data.runs.filter(r => r.timestamp?.startsWith(today));

  const tweets  = [];
  const errors  = [];
  let posted    = 0;

  for (const run of todayRuns) {
    if (run.tweetType) {
      const success = run.status === 'success' || run.publishResults?.some(r => r.success !== false);
      tweets.push({ type: run.tweetType, posted: success });
      if (success) posted++;
    }
    if (run.status === 'error' || run.error) {
      errors.push(`[${run.tweetType || 'pipeline'}] ${run.error || 'unknown error'}`);
    }
  }

  return { tweetsPosted: posted, tweetsScheduled: todayRuns.length, tweets, errors };
}

function getEngagementStats() {
  const logFile = path.join(process.cwd(), 'data', 'engagement_log.json');
  const data    = readJSON(logFile);
  if (!data || data.date !== todayART()) return { repliesPosted: 0 };
  return { repliesPosted: data.replies?.length || 0 };
}

function getFollowStats() {
  const logFile = path.join(process.cwd(), 'data', 'follow_log.json');
  const data    = readJSON(logFile);
  if (!data || data.date !== todayART()) return { followsToday: 0 };
  return { followsToday: data.follows?.length || 0 };
}

function getDailySchedule() {
  const schedFile = path.join(process.cwd(), 'data', 'daily_schedule.json');
  return readJSON(schedFile);
}

// ─── Aggregator principal ──────────────────────────────────────────────────────

async function runDailyHealthCheck() {
  log.info('Ejecutando daily health check...');

  const pipeline   = getPipelineStats();
  const engagement = getEngagementStats();
  const follows    = getFollowStats();
  const errStats   = getErrorStats();

  // Combinar errores de todas las fuentes
  const allErrors = [
    ...pipeline.errors,
    ...(errStats.recentErrors.slice(0, 5).map(e => `[${e.module}] ${e.message}`)),
  ].filter(Boolean);

  // Warnings
  const warnings = [];
  if (pipeline.tweetsPosted < pipeline.tweetsScheduled) {
    warnings.push(`Solo ${pipeline.tweetsPosted}/${pipeline.tweetsScheduled} tweets publicados`);
  }
  if (engagement.repliesPosted === 0) {
    warnings.push('No se publicaron replies hoy');
  }
  if (errStats.totalErrors > 0) {
    warnings.push(`${errStats.totalErrors} error(s) capturado(s) durante el día`);
  }

  // Determinar status
  let status = 'OK';
  if (allErrors.length > 0 || pipeline.tweetsPosted === 0) status = 'ERROR';
  else if (warnings.length > 0) status = 'DEGRADED';

  const stats = {
    date:             todayART(),
    status,
    tweetsPosted:     pipeline.tweetsPosted,
    tweetsScheduled:  pipeline.tweetsScheduled || 6,
    tweets:           pipeline.tweets,
    repliesPosted:    engagement.repliesPosted,
    followsToday:     follows.followsToday,
    errorCount:       errStats.totalErrors,
    warnings,
    errors:           allErrors,
  };

  log.info(`Health check: status=${status} | tweets=${stats.tweetsPosted}/${stats.tweetsScheduled} | replies=${stats.repliesPosted} | follows=${stats.followsToday} | errors=${stats.errorCount}`);

  await sendHealthReport(stats);

  // ── Growth Intelligence Report ────────────────────────────────────────────
  try {
    const patterns  = getLatestPatterns();
    const strategy  = getCurrentStrategy();
    const today_avg = patterns.avg_score || 0;

    // Check for degradation (compare recent 7 entries vs previous 7)
    const allEntries = (require('../performance/performanceEngine').loadPerformanceLog)?.() || [];
    const last7      = allEntries.slice(-7).map(e => e.metrics?.engagement_score || 0);
    const prev7      = allEntries.slice(-14, -7).map(e => e.metrics?.engagement_score || 0);
    const avgLast    = last7.length  ? last7.reduce((a, b) => a + b, 0)  / last7.length  : 0;
    const avgPrev    = prev7.length  ? prev7.reduce((a, b) => a + b, 0)  / prev7.length  : 0;
    const isDegraded = avgPrev > 0 && avgLast < avgPrev * 0.7; // >30% drop

    if (isDegraded) {
      log.warn(`Performance degradation detected: ${avgLast.toFixed(1)} vs ${avgPrev.toFixed(1)}`);
      await sendPerformanceDegradationAlert({
        today_avg:   avgLast,
        yesterday_avg: avgPrev,
        suspected_cause: patterns.trend === 'degrading'
          ? `${patterns.worst_type} content underperforming consistently. Consider diversifying.`
          : 'Recent drop — may be temporary or API related.',
        top_failures: Object.entries(patterns.by_type || {})
          .sort(([, a], [, b]) => a.avg_score - b.avg_score)
          .slice(0, 3)
          .map(([type, d]) => ({ type, score: d.avg_score })),
      });
    }

    await sendGrowthIntelligenceReport({
      patterns,
      strategy,
      liveAdjusterStats: {},
      date: todayART(),
    });

    log.info('Growth intelligence report sent');
  } catch (growthErr) {
    log.warn(`Growth report error (non-fatal): ${growthErr.message}`);
  }

  // Reset contador de errores para el día siguiente
  const { resetErrorCount } = require('./errorMonitor');
  resetErrorCount();

  return stats;
}

module.exports = { runDailyHealthCheck };
