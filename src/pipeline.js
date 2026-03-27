'use strict';

require('dotenv').config();

const { config, validateConfig } = require('./config');
const { createModuleLogger } = require('./utils/logger');
const { sleep } = require('./utils/retry');

// Data
const { getFullMarketSnapshot } = require('./data/marketData');
const { analyzeAllTokens } = require('./data/technicalAnalysis');

// Narrative
const { fetchNarrativeTweets } = require('./narrative/twitterScraper');
const { detectNarratives } = require('./narrative/narrativeDetector');
const { analyzeNarrativesWithAI, detectNarrativePriceDivergences } = require('./narrative/sentimentAnalyzer');

// Analysis
const { fuseInsights } = require('./analysis/fusionEngine');

// Content
const { generateDailyContent } = require('./content/contentGenerator');

// Storage
const {
  initStorage,
  saveMarketSnapshot,
  saveNarratives,
  saveInsights,
  saveTweets,
  logPipelineRun,
  hasRunToday,
  cleanupOldFiles,
} = require('./storage/dataStore');

// Twitter
const { postThread, publishTweetsImmediate } = require('./twitter/twitterClient');

// Quality + Alerts
const { qualityGate }    = require('./quality/contentQuality');
const { sendErrorAlert } = require('./alerts/emailAlerts');

// ─── Adaptive systems (non-blocking — fallback gracefully) ────────────────────
let runFeedbackLoop      = async () => ({});
let runPerformanceEngine = async () => null;
let getCallbackTweet     = async () => null;

try { runFeedbackLoop      = require('./performance/feedbackLoop').runFeedbackLoop;           } catch (e) {}
try { runPerformanceEngine = require('./performance/performanceEngine').runPerformanceEngine;  } catch (e) {}
try { getCallbackTweet     = require('./context/callbackEngine').getCallbackTweet;             } catch (e) {}

const log = createModuleLogger('Pipeline');

// ─── Local Quality Check (gratis — reemplaza GPT quality gate) ──────────────

/**
 * Validación de calidad por reglas, sin llamar a GPT.
 * Costo: $0. Detecta problemas obvios antes de publicar.
 * @param {string} text - Contenido del tweet
 * @param {string} type - Tipo de tweet
 * @returns {string[]} - Lista de issues (vacía = ok)
 */
function localQualityCheck(text, type) {
  const issues = [];

  if (!text || text.trim().length === 0) {
    issues.push('Tweet vacío');
    return issues;
  }

  // Longitud
  if (text.length > 280) issues.push(`Excede 280 chars (${text.length})`);
  if (text.length < 50)  issues.push(`Muy corto (${text.length} chars)`);

  // Contenido genérico / spam
  const genericPhrases = [
    /the future of/i, /game.?changer/i, /this is huge/i,
    /to the moon/i, /not financial advice/i, /WAGMI/i, /NGMI/i,
    /buy now/i, /don't miss/i, /last chance/i,
  ];
  for (const re of genericPhrases) {
    if (re.test(text)) {
      issues.push(`Frase genérica detectada: ${re.source}`);
      break;
    }
  }

  // Debe tener al menos un dato concreto (número, $, %)
  const hasData = /\d/.test(text) || /\$/.test(text) || /%/.test(text);
  if (!hasData && type !== 'contrarian') {
    issues.push('Sin datos concretos (números, $ o %)');
  }

  // No repetir el mismo emoji más de 3 veces
  const emojiMatch = text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu);
  if (emojiMatch && emojiMatch.length > 5) {
    issues.push(`Demasiados emojis (${emojiMatch.length})`);
  }

  // Hashtags excesivos
  const hashtags = (text.match(/#\w+/g) || []).length;
  if (hashtags > 3) issues.push(`Demasiados hashtags (${hashtags})`);

  return issues;
}

// ─── Pipeline principal ────────────────────────────────────────────────────────

/**
 * Ejecuta el pipeline completo
 * @param {object} opts
 * @param {boolean} opts.dryRun - Simular sin publicar
 * @param {boolean} opts.skipPosting - Ejecutar análisis pero no publicar
 * @param {boolean} opts.forceRun - Ignorar verificación de "ya corrió hoy"
 * @param {string|null} opts.tweetType - Si se pasa, solo genera y publica 1 tweet de ese tipo
 */
async function runPipeline(opts = {}) {
  const {
    dryRun = config.content.dryRun,
    skipPosting = false,
    forceRun = false,
    tweetType = null,
  } = opts;

  const startTime = Date.now();
  const runId = `run_${Date.now()}`;

  log.info('═══════════════════════════════════════════════════════════');
  log.info(`PIPELINE INICIADO | ID: ${runId} | DryRun: ${dryRun}`);
  log.info('═══════════════════════════════════════════════════════════');

  // ─── Validación inicial ──────────────────────────────────────────────────────
  try {
    const warnings = validateConfig();
    for (const w of warnings) log.warn(w);
  } catch (err) {
    log.error(`Configuración inválida: ${err.message}`);
    setImmediate(() => sendErrorAlert({ module: 'Pipeline:validateConfig', error: err.message, stack: err.stack, context: { runId } }).catch(() => {}));
    throw err;
  }

  // ─── Verificar ejecución duplicada ───────────────────────────────────────────
  if (!forceRun && !dryRun) {
    const alreadyRan = await hasRunToday();
    if (alreadyRan) {
      log.info('Pipeline ya ejecutado hoy. Usar forceRun=true para forzar.');
      return null;
    }
  }

  // ─── Inicializar storage ─────────────────────────────────────────────────────
  await initStorage();

  const pipelineStages = {};

  // ════════════════════════════════════════════════════════════════════
  // ETAPA 1: Datos de mercado
  // ════════════════════════════════════════════════════════════════════
  log.info('\n── ETAPA 1: DATOS DE MERCADO ──────────────────────────────');

  let marketSnapshot;
  try {
    marketSnapshot = await getFullMarketSnapshot();
    await saveMarketSnapshot(marketSnapshot);
    pipelineStages.market = { status: 'ok', tokenCount: marketSnapshot.tokens.length };
    log.info(`ETAPA 1 completada: ${marketSnapshot.tokens.length} tokens procesados`);
  } catch (err) {
    log.error(`ETAPA 1 FALLIDA: ${err.message}`);
    pipelineStages.market = { status: 'failed', error: err.message };
    throw new Error(`Fallo crítico en datos de mercado: ${err.message}`);
  }

  // ════════════════════════════════════════════════════════════════════
  // ETAPA 2: Análisis técnico
  // ════════════════════════════════════════════════════════════════════
  log.info('\n── ETAPA 2: ANÁLISIS TÉCNICO ──────────────────────────────');

  let technicalAnalyses;
  try {
    technicalAnalyses = analyzeAllTokens(marketSnapshot);
    pipelineStages.technical = {
      status: 'ok',
      bullish: technicalAnalyses.filter(t => t.bias === 'bullish').length,
      bearish: technicalAnalyses.filter(t => t.bias === 'bearish').length,
    };
    log.info('ETAPA 2 completada');
  } catch (err) {
    log.error(`ETAPA 2 FALLIDA: ${err.message}`);
    pipelineStages.technical = { status: 'failed', error: err.message };
    technicalAnalyses = []; // continuar con análisis vacío
  }

  // ════════════════════════════════════════════════════════════════════
  // ETAPA 3: Detección de narrativas
  // ════════════════════════════════════════════════════════════════════
  log.info('\n── ETAPA 3: DETECCIÓN DE NARRATIVAS ──────────────────────');

  let narrativeData;
  let aiNarrativeAnalysis = {};

  // COST OPTIMIZATION: Si Twitter reads está deshabilitado (Free tier $0/mes),
  // skip narrativas completamente. Ahorra ~$100/mes en Twitter API.
  const skipNarratives = config.twitter.readsDisabled;

  if (skipNarratives) {
    log.info('ETAPA 3 SKIPPED: Twitter reads disabled (Free tier). Usando fallback neutral.');
    narrativeData = {
      totalTweets: 0,
      sentiment: { label: 'neutral', score: 0, distribution: { positive: 50, negative: 50 } },
      narrativeScores: [],
      emergingTopics: [],
      tokenMentions: [],
      queryMetrics: [],
      summary: { leadingNarratives: [], mostMentionedTokens: [], emergingTerms: [], insights: [] },
    };
    aiNarrativeAnalysis = {
      overallNarrativeAssessment: 'Skipped — Twitter reads disabled for cost optimization',
      keyInsights: [],
      contentAngles: [],
    };
    pipelineStages.narrative = { status: 'skipped_reads_disabled' };
  } else {
    try {
      const tweetData = await fetchNarrativeTweets();
      narrativeData = detectNarratives(tweetData);

      log.info('Analizando narrativas con AI...');
      try {
        aiNarrativeAnalysis = await analyzeNarrativesWithAI(narrativeData, technicalAnalyses);
      } catch (aiErr) {
        log.error(`Error en análisis AI de narrativas: ${aiErr.message}`);
        aiNarrativeAnalysis = {
          overallNarrativeAssessment: 'AI analysis unavailable',
          keyInsights: [],
          contentAngles: [],
        };
      }

      await saveNarratives({ narrativeData, aiNarrativeAnalysis });
      pipelineStages.narrative = {
        status: 'ok',
        tweets: narrativeData.totalTweets,
        dominant: narrativeData.dominantNarrative?.narrative,
        sentiment: narrativeData.sentiment.label,
      };
      log.info('ETAPA 3 completada');
    } catch (err) {
      log.error(`ETAPA 3 FALLIDA: ${err.message}`);
      pipelineStages.narrative = { status: 'failed', error: err.message };

      // Fallback mínimo
      narrativeData = {
        totalTweets: 0,
        sentiment: { label: 'neutral', score: 0, distribution: { positive: 50, negative: 50 } },
        narrativeScores: [],
        emergingTopics: [],
        tokenMentions: [],
        queryMetrics: [],
        summary: { leadingNarratives: [], mostMentionedTokens: [], emergingTerms: [], insights: [] },
      };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // ETAPA 4: Fusión de insights
  // ════════════════════════════════════════════════════════════════════
  log.info('\n── ETAPA 4: FUSIÓN DE INSIGHTS ────────────────────────────');

  let fusionData;
  try {
    fusionData = fuseInsights(marketSnapshot, technicalAnalyses, narrativeData, aiNarrativeAnalysis);
    fusionData.marketSnapshot = marketSnapshot; // adjuntar para imagen generation

    // Detectar divergencias
    const divergences = detectNarrativePriceDivergences(narrativeData, technicalAnalyses);
    fusionData.priceDivergences = divergences;

    await saveInsights(fusionData);
    pipelineStages.fusion = {
      status: 'ok',
      topToken: fusionData.tokens[0]?.symbol,
      marketPhase: fusionData.macroSignals.marketPhase,
    };
    log.info(`ETAPA 4 completada. Fase de mercado: ${fusionData.macroSignals.marketPhase}`);
  } catch (err) {
    log.error(`ETAPA 4 FALLIDA: ${err.message}`);
    pipelineStages.fusion = { status: 'failed', error: err.message };
    throw new Error(`Fallo crítico en fusión de insights: ${err.message}`);
  }

  // ════════════════════════════════════════════════════════════════════
  // FEEDBACK LOOP: Adaptive strategy update (before content generation)
  // ════════════════════════════════════════════════════════════════════
  log.info('\n── FEEDBACK LOOP: ESTRATEGIA ADAPTATIVA ─────────────────');
  try {
    const fbResult = await runFeedbackLoop();
    if (fbResult?.strategy) {
      log.info(`Strategy: ${fbResult.strategy.reason}`);
      log.info(`Preferred types: ${fbResult.strategy.preferred_types?.join(', ')}`);
      log.info(`Focus tokens: ${fbResult.strategy.focus_tokens?.join(', ')}`);
    }
  } catch (fbErr) {
    log.warn(`Feedback loop (non-fatal): ${fbErr.message}`);
  }

  // ── Callback tweet injection (at least 1 callback/day) ───────────────────
  let callbackTweet = null;
  try {
    callbackTweet = await getCallbackTweet(fusionData);
    if (callbackTweet) {
      log.info(`Callback tweet ready: "${callbackTweet.substring(0, 60)}..."`);
      fusionData._callbackTweet = callbackTweet; // pass to contentGenerator
    }
  } catch (cbErr) {
    log.warn(`Callback engine (non-fatal): ${cbErr.message}`);
  }

  // ════════════════════════════════════════════════════════════════════
  // ETAPA 5: Generación de contenido
  // ════════════════════════════════════════════════════════════════════
  log.info('\n── ETAPA 5: GENERACIÓN DE CONTENIDO ──────────────────────');

  // Determinar si hoy corresponde generar thread
  const dayOfYear = Math.floor(Date.now() / 86400000);
  const includeThread = (dayOfYear % config.content.threadEveryNDays === 0);

  let generatedContent;
  try {
    generatedContent = await generateDailyContent(fusionData, includeThread, tweetType);

    // Inject callback tweet as an extra tweet slot if available
    if (fusionData._callbackTweet && !tweetType) {
      generatedContent.tweets.push({
        id:          `tweet_${Date.now()}_callback`,
        type:        'callback',
        content:     fusionData._callbackTweet,
        charCount:   fusionData._callbackTweet.length,
        scheduledFor: null,
        posted:      false,
        postId:      null,
        generatedAt: new Date().toISOString(),
      });
      log.info('Callback tweet injected into daily content');
    }

    await saveTweets(generatedContent);

    pipelineStages.content = {
      status: 'ok',
      tweetsGenerated: generatedContent.tweets.length,
      hasThread: !!generatedContent.thread,
    };
    log.info(`ETAPA 5 completada: ${generatedContent.tweets.length} tweets generados`);

    // Logging de contenido generado
    log.info('\n── CONTENIDO GENERADO ─────────────────────────────────────');
    for (const tweet of generatedContent.tweets) {
      log.info(`\n[${tweet.type.toUpperCase()}] (${tweet.content.length} chars):\n${tweet.content}`);
    }

    if (generatedContent.thread) {
      log.info('\n── THREAD GENERADO ────────────────────────────────────────');
      generatedContent.thread.tweets.forEach((t, i) => {
        log.info(`[${i + 1}/${generatedContent.thread.tweetCount}] ${t.tweet}`);
      });
    }

  } catch (err) {
    log.error(`ETAPA 5 FALLIDA: ${err.message}`);
    pipelineStages.content = { status: 'failed', error: err.message };
    throw new Error(`Fallo en generación de contenido: ${err.message}`);
  }

  // ════════════════════════════════════════════════════════════════════
  // ETAPA 6: Publicación en Twitter
  // ════════════════════════════════════════════════════════════════════
  log.info('\n── ETAPA 6: PUBLICACIÓN EN TWITTER ───────────────────────');

  let publishResults = [];

  if (skipPosting) {
    log.info('Publicación omitida (skipPosting=true)');
    pipelineStages.posting = { status: 'skipped' };
  } else if (dryRun) {
    log.info('[DRY RUN] Tweets no publicados');
    pipelineStages.posting = { status: 'dry_run' };
  } else if (!config.twitter.appKey) {
    log.warn('Twitter credentials no configuradas. Omitiendo publicación.');
    pipelineStages.posting = { status: 'skipped_no_credentials' };
  } else {
    try {
      // ── Quality gate: validación local (gratis) o GPT (pago) ─────────
      const qgMode = config.content.qualityGateMode || 'local';
      log.info(`Quality gate mode: ${qgMode}`);

      if (qgMode === 'gpt') {
        // GPT quality gate (cuesta ~$0.05-0.10 por tweet)
        for (const tweet of generatedContent.tweets) {
          if (tweet.posted || !tweet.content) continue;
          try {
            const generator = () => {
              const { generateMarketInsightTweet, generateTechnicalTweet, generateNarrativeTweet,
                      generateContrarianTweet, generateSystemTweet, TWEET_TYPES } = require('./content/contentGenerator');
              const map = {
                [TWEET_TYPES.MARKET_INSIGHT]: generateMarketInsightTweet,
                [TWEET_TYPES.TECHNICAL_ANALYSIS]: generateTechnicalTweet,
                [TWEET_TYPES.NARRATIVE_INSIGHT]: generateNarrativeTweet,
                [TWEET_TYPES.CONTRARIAN]: generateContrarianTweet,
                [TWEET_TYPES.SYSTEM_THINKING]: generateSystemTweet,
              };
              const fn = map[tweet.type];
              return fn ? fn(fusionData) : null;
            };
            tweet.content = await qualityGate(tweet.content, tweet.type, generator);
          } catch (qErr) {
            log.warn(`Quality gate GPT error for ${tweet.type}: ${qErr.message} — using original`);
          }
        }
      } else {
        // LOCAL quality gate (gratis — validación por reglas)
        for (const tweet of generatedContent.tweets) {
          if (tweet.posted || !tweet.content) continue;
          const issues = localQualityCheck(tweet.content, tweet.type);
          if (issues.length > 0) {
            log.warn(`[${tweet.type}] Quality issues: ${issues.join(', ')}`);
          } else {
            log.info(`[${tweet.type}] ✅ Local quality check passed`);
          }
        }
      }

      // Publicar tweets individuales
      publishResults = await publishTweetsImmediate(generatedContent.tweets, fusionData);

      // Publicar thread si existe
      if (generatedContent.thread) {
        log.info('Publicando thread...');
        await sleep(60000); // esperar 1 minuto antes del thread
        const threadResults = await postThread(generatedContent.thread.tweets);
        publishResults.push({ type: 'thread', results: threadResults });
      }

      const publishedCount = publishResults.filter(r => r.success !== false).length;
      const failedCount    = publishResults.filter(r => r.success === false).length;

      // Reportar status correctamente: si TODOS fallaron, es un fallo
      const postingStatus = publishedCount === 0 && failedCount > 0
        ? 'failed'
        : failedCount > 0 ? 'partial' : 'ok';

      pipelineStages.posting = {
        status:    postingStatus,
        published: publishedCount,
        failed:    failedCount,
      };

      if (postingStatus === 'failed') {
        log.error(`⚠️ ETAPA 6: TODOS los tweets fallaron (${failedCount} fallos). Verificar tokens OAuth2.`);
        // Enviar alerta async (no bloquear)
        setImmediate(async () => {
          try {
            const { sendErrorAlert } = require('./alerts/emailAlerts');
            await sendErrorAlert({
              module: 'Pipeline — Publicación fallida',
              error: `0/${failedCount} tweets publicados. Posible token OAuth2 expirado.`,
              stack: publishResults.filter(r => r.success === false).map(r => `${r.type}: ${r.error}`).join('\n'),
              context: { accion: 'Verificar tokens OAuth2 — node scripts/reauthorize.js' },
            });
          } catch (e) { /* ignore */ }
        });
      } else {
        log.info(`ETAPA 6 completada: ${publishedCount} publicados, ${failedCount} fallidos`);
      }

      // Performance fetch ahora lo maneja el scheduler (1×/día 19:00 ART)
      // Eliminado el setTimeout de 15min que se perdía en restart de PM2
    } catch (err) {
      log.error(`ETAPA 6 ERROR: ${err.message}`);
      pipelineStages.posting = { status: 'partial_failure', error: err.message };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // FINALIZACIÓN
  // ════════════════════════════════════════════════════════════════════

  await cleanupOldFiles(30);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const runSummary = {
    id: runId,
    duration: `${elapsed} min`,
    stages: pipelineStages,
    date: new Date().toISOString().split('T')[0],
    dryRun,
    success: !Object.values(pipelineStages).some(s => s.status === 'failed' && s !== pipelineStages.posting)
              && pipelineStages.posting?.status !== 'failed',
  };

  await logPipelineRun(runSummary);

  log.info('\n═══════════════════════════════════════════════════════════');
  log.info(`PIPELINE COMPLETADO en ${elapsed} minutos`);
  log.info(`Etapas: ${JSON.stringify(pipelineStages, null, 2)}`);
  log.info('═══════════════════════════════════════════════════════════\n');

  return {
    runSummary,
    fusionData,
    generatedContent,
    publishResults,
  };
}

// ─── Entry point directo ───────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const forceRun = args.includes('--force');
  const skipPosting = args.includes('--skip-posting');
  const tweetTypeArg = args.find(a => a.startsWith('--type='));
  const tweetType = tweetTypeArg ? tweetTypeArg.split('=')[1] : null;

  runPipeline({ dryRun, forceRun, skipPosting, tweetType })
    .then(result => {
      if (result) {
        log.info('Pipeline finalizado exitosamente');
        process.exit(0);
      } else {
        log.info('Pipeline omitido (ya ejecutado hoy)');
        process.exit(0);
      }
    })
    .catch(err => {
      log.error(`Pipeline fallido: ${err.message}`);
      log.error(err.stack);
      process.exit(1);
    });
}

module.exports = { runPipeline };
