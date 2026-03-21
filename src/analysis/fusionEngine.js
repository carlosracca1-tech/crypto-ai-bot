'use strict';

const { createModuleLogger } = require('../utils/logger');
const { normalize } = require('../utils/helpers');

const log = createModuleLogger('FusionEngine');

/**
 * Combina análisis técnico + datos de mercado + narrativas
 * en un conjunto de insights unificados
 *
 * @param {object} marketSnapshot
 * @param {Array} technicalAnalyses
 * @param {object} narrativeData
 * @param {object} aiNarrativeAnalysis
 * @returns {object}
 */
function fuseInsights(marketSnapshot, technicalAnalyses, narrativeData, aiNarrativeAnalysis) {
  log.info('Fusionando datos de mercado, análisis técnico y narrativas...');

  // ─── Construir mapa de menciones por símbolo ───────────────────────────────
  const mentionMap = {};
  for (const m of narrativeData.tokenMentions || []) {
    mentionMap[m.symbol] = m;
  }

  // ─── Enriquecer cada token con score narrativo ─────────────────────────────
  const enrichedTokens = technicalAnalyses.map(tech => {
    const mention = mentionMap[tech.symbol] || { count: 0, totalEngagement: 0, avgEngagement: 0 };

    // Score narrativo: menciones + engagement ponderado
    const maxMentions = Math.max(...Object.values(mentionMap).map(m => m.count), 1);
    const maxEngagement = Math.max(...Object.values(mentionMap).map(m => m.avgEngagement), 1);

    const narrativeScore = mention.count > 0
      ? ((mention.count / maxMentions) * 60 + (mention.avgEngagement / maxEngagement) * 40)
      : 0;

    // Score compuesto: técnico 60% + narrativo 40%
    const compositeScore = (tech.technicalScore * 0.6) + (narrativeScore * 0.4);

    // Alineación narrativa-técnica
    const alignment = detectAlignment(tech.bias, narrativeScore, mention.count);

    // Señal de divergencia
    const divergence = detectTokenDivergence(tech, mention, narrativeScore);

    return {
      id: tech.id,
      symbol: tech.symbol,
      name: tech.name,
      currentPrice: tech.currentPrice,
      change24h: tech.change24h,
      volume24h: tech.volume24h,
      technicalBias: tech.bias,
      technicalScore: tech.technicalScore,
      maTrend: tech.maTrend,
      breakout: tech.breakout,
      rsi: tech.indicators?.rsi,
      macd: tech.indicators?.macd?.trend,
      narrativeScore: Math.round(narrativeScore),
      narrativeMentions: mention.count,
      narrativeEngagement: mention.avgEngagement,
      compositeScore: Math.round(compositeScore),
      alignment,
      divergence,
      signals: tech.signals || [],
      topSignals: (tech.signals || []).slice(0, 3).map(s => s.detail),
    };
  });

  // ─── Ordenar por score compuesto ───────────────────────────────────────────
  enrichedTokens.sort((a, b) => b.compositeScore - a.compositeScore);

  // ─── Tokens destacados ──────────────────────────────────────────────────────
  const topOpportunities = enrichedTokens
    .filter(t => t.compositeScore >= 60 && t.technicalBias !== 'bearish')
    .slice(0, 5);

  const topDivergences = enrichedTokens
    .filter(t => t.divergence?.type)
    .slice(0, 3);

  const highMomentum = enrichedTokens
    .filter(t => t.change24h > 5 || t.breakout?.type === 'bullish_breakout')
    .slice(0, 3);

  const oversold = enrichedTokens
    .filter(t => t.rsi && t.rsi < 32)
    .sort((a, b) => a.rsi - b.rsi)
    .slice(0, 3);

  // ─── Señales de mercado macro ──────────────────────────────────────────────
  const macroSignals = buildMacroSignals(marketSnapshot, narrativeData, enrichedTokens);

  // ─── Insights para generación de contenido ────────────────────────────────
  const contentInsights = buildContentInsights(
    enrichedTokens,
    narrativeData,
    aiNarrativeAnalysis,
    macroSignals,
    topDivergences
  );

  const result = {
    generatedAt: new Date().toISOString(),
    tokens: enrichedTokens,
    topOpportunities,
    topDivergences,
    highMomentum,
    oversoldTokens: oversold,
    macroSignals,
    narrativeSummary: narrativeData.summary,
    aiNarrativeAnalysis,
    contentInsights,
    marketOverview: marketSnapshot.marketOverview,
  };

  log.info(`Fusión completada. ${enrichedTokens.length} tokens enriquecidos. ${topOpportunities.length} oportunidades detectadas.`);
  return result;
}

/**
 * Detecta alineación entre precio/técnica y narrativa
 */
function detectAlignment(technicalBias, narrativeScore, mentions) {
  const hasNarrative = mentions >= 3;
  const strongNarrative = narrativeScore >= 40;

  if (technicalBias === 'bullish' && strongNarrative) {
    return {
      type: 'aligned_bullish',
      label: 'Price action and narrative aligned bullishly',
      confidence: 'high',
    };
  }

  if (technicalBias === 'bearish' && narrativeScore <= 15) {
    return {
      type: 'aligned_bearish',
      label: 'Both technical and narrative signal weakness',
      confidence: 'high',
    };
  }

  if (technicalBias === 'bullish' && !hasNarrative) {
    return {
      type: 'price_ahead_of_narrative',
      label: 'Price rising without narrative support',
      confidence: 'medium',
    };
  }

  if (technicalBias === 'bearish' && strongNarrative) {
    return {
      type: 'narrative_ahead_of_price',
      label: 'Strong narrative despite weak price action - accumulation signal',
      confidence: 'medium',
    };
  }

  return {
    type: 'neutral',
    label: 'No clear alignment signal',
    confidence: 'low',
  };
}

/**
 * Detecta divergencias específicas por token
 */
function detectTokenDivergence(tech, mention, narrativeScore) {
  if (!mention.count) return { type: null };

  const priceSurging = tech.change24h > 10;
  const priceWeakening = tech.change24h < -5;
  const narrativeStrong = narrativeScore > 50;
  const narrativeWeak = narrativeScore < 15;

  if (priceSurging && narrativeWeak) {
    return {
      type: 'price_narrative_divergence',
      direction: 'price_ahead',
      description: `${tech.symbol} up ${tech.change24h?.toFixed(1)}% without narrative backing - potential exhaustion`,
      severity: 'high',
    };
  }

  if (priceWeakening && narrativeStrong) {
    return {
      type: 'narrative_price_divergence',
      direction: 'narrative_ahead',
      description: `${tech.symbol} down ${Math.abs(tech.change24h)?.toFixed(1)}% while narrative remains strong - potential opportunity`,
      severity: 'medium',
    };
  }

  if (tech.breakout?.type === 'bullish_breakout' && narrativeStrong) {
    return {
      type: 'confirmed_breakout',
      direction: 'bullish',
      description: `${tech.symbol} breaking out with strong narrative support`,
      severity: 'low',
    };
  }

  return { type: null };
}

/**
 * Construye señales macroeconómicas del mercado AI
 */
function buildMacroSignals(marketSnapshot, narrativeData, enrichedTokens) {
  const { marketOverview } = marketSnapshot;
  const { sentiment, narrativeScores } = narrativeData;

  const avgTechnicalScore = enrichedTokens.reduce((a, t) => a + t.technicalScore, 0) / enrichedTokens.length;
  const bullishTokens = enrichedTokens.filter(t => t.technicalBias === 'bullish').length;
  const bearishTokens = enrichedTokens.filter(t => t.technicalBias === 'bearish').length;

  const marketPhase = determineMarketPhase(avgTechnicalScore, sentiment.score, marketOverview.avgChange24h);

  return {
    aiMarketCapTotal: marketOverview.totalMarketCap,
    avgChange24h: marketOverview.avgChange24h?.toFixed(2),
    bullishTokenCount: bullishTokens,
    bearishTokenCount: bearishTokens,
    neutralTokenCount: enrichedTokens.length - bullishTokens - bearishTokens,
    avgTechnicalScore: Math.round(avgTechnicalScore),
    overallSentiment: sentiment.label,
    sentimentScore: sentiment.score.toFixed(2),
    dominantNarrative: narrativeScores[0]?.narrative,
    narrativeStrength: narrativeScores[0]?.strength,
    marketPhase,
    topGainers: marketOverview.topGainers24h || [],
    topLosers: marketOverview.topLosers24h || [],
  };
}

/**
 * Determina la fase del mercado AI
 */
function determineMarketPhase(technicalScore, sentimentScore, avgChange24h) {
  const techBull = technicalScore > 60;
  const techBear = technicalScore < 40;
  const sentBull = sentimentScore > 0.15;
  const sentBear = sentimentScore < -0.15;
  const priceBull = avgChange24h > 3;
  const priceBear = avgChange24h < -3;

  if (techBull && sentBull && priceBull) return 'bull_market';
  if (techBear && sentBear && priceBear) return 'bear_market';
  if (techBull && priceBull && !sentBull) return 'recovery';
  if (techBear && !sentBear && priceBear) return 'correction';
  if (!techBull && !techBear && Math.abs(avgChange24h) < 2) return 'consolidation';
  if (techBull && sentBear) return 'accumulation';
  return 'uncertain';
}

/**
 * Construye insights orientados a generación de contenido
 */
function buildContentInsights(enrichedTokens, narrativeData, aiNarrativeAnalysis, macroSignals, divergences) {
  const insights = {
    marketInsight: buildMarketInsight(enrichedTokens, macroSignals),
    technicalInsight: buildTechnicalInsight(enrichedTokens),
    narrativeInsight: buildNarrativeInsight(narrativeData, aiNarrativeAnalysis),
    contrarianInsight: buildContrarianInsight(enrichedTokens, narrativeData, macroSignals),
    systemInsight: buildSystemInsight(macroSignals, narrativeData),
    divergenceInsight: divergences.length > 0 ? buildDivergenceInsight(divergences) : null,
  };

  return insights;
}

function buildMarketInsight(tokens, macroSignals) {
  const top = tokens[0];
  const phase = macroSignals.marketPhase;
  const gainers = macroSignals.topGainers.slice(0, 3).map(g => `${g.symbol} (${g.change24h?.toFixed(1)}%)`).join(', ');

  return {
    type: 'market_insight',
    headline: `AI crypto sector is in ${phase.replace('_', ' ')} phase`,
    dataPoints: [
      `${macroSignals.bullishTokenCount}/${tokens.length} tokens showing bullish technicals`,
      `Average 24h change: ${macroSignals.avgChange24h}%`,
      `Overall narrative sentiment: ${macroSignals.overallSentiment}`,
      gainers ? `Top performers: ${gainers}` : null,
    ].filter(Boolean),
    focusToken: top?.symbol,
  };
}

function buildTechnicalInsight(tokens) {
  const breakoutToken = tokens.find(t => t.breakout?.type === 'bullish_breakout');
  const oversoldToken = tokens.find(t => t.rsi && t.rsi < 30);
  const strongTrend = tokens.find(t => t.maTrend === 'strong_uptrend');

  const primary = breakoutToken || strongTrend || tokens[0];

  return {
    type: 'technical_analysis',
    headline: breakoutToken
      ? `${breakoutToken.symbol} breaking out of ${primary.breakout?.lookback || 20}-day resistance`
      : `${primary?.symbol} ${primary?.maTrend?.replace('_', ' ')} on daily timeframe`,
    dataPoints: [
      primary && `RSI(14): ${primary.rsi?.toFixed(1)}`,
      primary && `MACD: ${primary.macd}`,
      primary && `MA trend: ${primary.maTrend}`,
      oversoldToken && `${oversoldToken.symbol} at oversold RSI: ${oversoldToken.rsi?.toFixed(1)}`,
    ].filter(Boolean),
    focusToken: primary?.symbol,
    secondaryToken: oversoldToken?.symbol,
  };
}

function buildNarrativeInsight(narrativeData, aiAnalysis) {
  const dominant = narrativeData.narrativeScores?.[0];
  const emerging = narrativeData.emergingTopics?.[0];

  return {
    type: 'narrative_insight',
    headline: aiAnalysis?.emergingNarrativeAlert?.topic
      ? `Emerging: ${aiAnalysis.emergingNarrativeAlert.topic}`
      : `${dominant?.narrative} narrative dominates AI crypto discourse`,
    dataPoints: aiAnalysis?.keyInsights || narrativeData.summary?.insights || [],
    sentiment: narrativeData.sentiment?.label,
    contentAngles: aiAnalysis?.contentAngles || [],
  };
}

function buildContrarianInsight(tokens, narrativeData, macroSignals) {
  // Busca tokens muy mencionados pero técnicamente débiles
  const hyperTarget = tokens.find(t =>
    t.narrativeScore > 50 && t.technicalBias === 'bearish' && t.change24h < -3
  );

  // O tokens olvidados técnicamente fuertes
  const overlooked = tokens.find(t =>
    t.narrativeScore < 15 && t.technicalBias === 'bullish' && t.technicalScore > 65
  );

  const target = hyperTarget || overlooked;

  return {
    type: 'contrarian',
    headline: hyperTarget
      ? `${hyperTarget.symbol}: Heavy narrative attention while price weakens`
      : overlooked
        ? `${overlooked.symbol}: Strong technicals overlooked by the market`
        : 'Divergence between narrative heat and price action in AI sector',
    dataPoints: [
      hyperTarget && `${hyperTarget.symbol} trending on Twitter but down ${Math.abs(hyperTarget.change24h)?.toFixed(1)}%`,
      overlooked && `${overlooked.symbol} technical score: ${overlooked.technicalScore}/100 - minimal social activity`,
      `Market phase: ${macroSignals.marketPhase}`,
    ].filter(Boolean),
    focusToken: target?.symbol,
  };
}

function buildSystemInsight(macroSignals, narrativeData) {
  return {
    type: 'system_thinking',
    headline: 'Structural dynamics in decentralized AI infrastructure',
    dataPoints: [
      `Dominant narrative: ${macroSignals.dominantNarrative}`,
      `Narrative strength: ${macroSignals.narrativeStrength}`,
      `${narrativeData.totalTweets} tweets analyzed across ${narrativeData.queryMetrics?.length || 0} search queries`,
      narrativeData.summary?.insights?.[0],
    ].filter(Boolean),
  };
}

function buildDivergenceInsight(divergences) {
  const top = divergences[0];
  return {
    type: 'divergence',
    headline: top.divergence?.description || 'Price-narrative divergence detected',
    dataPoints: divergences.map(d => d.divergence?.description).filter(Boolean),
    focusToken: top.symbol,
  };
}

module.exports = {
  fuseInsights,
  detectAlignment,
  detectTokenDivergence,
  buildMacroSignals,
  determineMarketPhase,
};
