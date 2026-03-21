'use strict';

const ti = require('technicalindicators');
const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { mean, stdDev, rsiSignal } = require('../utils/helpers');

const log = createModuleLogger('TechnicalAnalysis');

// ─── Indicadores base ──────────────────────────────────────────────────────────

/**
 * Calcula RSI
 * @param {number[]} closes - Array de precios de cierre
 * @param {number} period
 * @returns {number|null}
 */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const values = ti.RSI.calculate({ values: closes, period });
  return values.length ? values[values.length - 1] : null;
}

/**
 * Calcula MACD
 * @param {number[]} closes
 * @returns {object|null}
 */
function calcMACD(closes) {
  const { macdFast, macdSlow, macdSignal } = config.technicalAnalysis;
  if (closes.length < macdSlow + macdSignal) return null;

  const values = ti.MACD.calculate({
    values: closes,
    fastPeriod: macdFast,
    slowPeriod: macdSlow,
    signalPeriod: macdSignal,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  if (!values.length) return null;
  const last = values[values.length - 1];
  const prev = values[values.length - 2];

  return {
    macd: last.MACD,
    signal: last.signal,
    histogram: last.histogram,
    prevHistogram: prev?.histogram,
    // Cruce: histogram cambia de signo
    bullishCross: prev?.histogram < 0 && last.histogram > 0,
    bearishCross: prev?.histogram > 0 && last.histogram < 0,
    trend: last.MACD > last.signal ? 'bullish' : 'bearish',
  };
}

/**
 * Calcula Media Móvil Simple
 * @param {number[]} closes
 * @param {number} period
 * @returns {number|null}
 */
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const values = ti.SMA.calculate({ values: closes, period });
  return values.length ? values[values.length - 1] : null;
}

/**
 * Calcula Media Móvil Exponencial
 * @param {number[]} closes
 * @param {number} period
 * @returns {number|null}
 */
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const values = ti.EMA.calculate({ values: closes, period });
  return values.length ? values[values.length - 1] : null;
}

/**
 * Calcula Bollinger Bands
 * @param {number[]} closes
 * @param {number} period
 * @param {number} multiplier
 * @returns {object|null}
 */
function calcBollingerBands(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return null;

  const values = ti.BollingerBands.calculate({
    period,
    values: closes,
    stdDev: multiplier,
  });

  if (!values.length) return null;
  const last = values[values.length - 1];
  const currentPrice = closes[closes.length - 1];

  return {
    upper: last.upper,
    middle: last.middle,
    lower: last.lower,
    bandwidth: (last.upper - last.lower) / last.middle,
    percentB: (currentPrice - last.lower) / (last.upper - last.lower),
    squeezing: (last.upper - last.lower) / last.middle < 0.05,
  };
}

/**
 * Calcula ATR (Average True Range)
 * @param {Array<{high, low, close}>} candles
 * @param {number} period
 * @returns {number|null}
 */
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const input = candles.map(c => ({
    high: c.high,
    low: c.low,
    close: c.close,
  }));

  const values = ti.ATR.calculate({ period, ...transposeCandles(input) });
  return values.length ? values[values.length - 1] : null;
}

function transposeCandles(candles) {
  return {
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
  };
}

// ─── Análisis de volumen ───────────────────────────────────────────────────────

/**
 * Analiza tendencia de volumen
 * @param {number[]} volumes
 * @returns {object}
 */
function analyzeVolumeTrend(volumes) {
  if (volumes.length < 5) return { trend: 'unknown', ratio: null };

  const recent = volumes.slice(-5);
  const period = config.technicalAnalysis.volumeAvgPeriod;
  const avgVolume = mean(volumes.slice(-period));
  const currentVol = volumes[volumes.length - 1];
  const ratio = currentVol / avgVolume;

  // Pendiente de regresión lineal simple sobre últimas 5 velas
  const slope = linearRegressionSlope(recent);

  return {
    currentVolume: currentVol,
    avgVolume,
    ratio,
    trend: slope > 0.02 ? 'increasing' : slope < -0.02 ? 'decreasing' : 'flat',
    spike: ratio > 2.0,
    dry: ratio < 0.5,
    label:
      ratio > 3.0 ? 'volume_surge'
      : ratio > 1.5 ? 'above_average'
      : ratio < 0.5 ? 'below_average'
      : 'normal',
  };
}

/**
 * Pendiente de regresión lineal normalizada
 */
function linearRegressionSlope(values) {
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  if (den === 0) return 0;
  return (num / den) / yMean; // normalizada
}

// ─── Detección de patrones ─────────────────────────────────────────────────────

/**
 * Detecta si hay breakout de resistencia/soporte
 * @param {number[]} closes
 * @param {number} lookback
 * @returns {object}
 */
function detectBreakout(closes, lookback = 20) {
  if (closes.length < lookback + 1) return { type: null };

  const window = closes.slice(-lookback - 1, -1);
  const currentPrice = closes[closes.length - 1];
  const resistance = Math.max(...window);
  const support = Math.min(...window);
  const range = resistance - support;

  const threshold = range * 0.02; // 2% del rango

  if (currentPrice > resistance + threshold) {
    return {
      type: 'bullish_breakout',
      level: resistance,
      pctAbove: ((currentPrice - resistance) / resistance) * 100,
    };
  }

  if (currentPrice < support - threshold) {
    return {
      type: 'bearish_breakdown',
      level: support,
      pctBelow: ((support - currentPrice) / support) * 100,
    };
  }

  return {
    type: 'consolidating',
    resistance,
    support,
    rangePercent: (range / support) * 100,
  };
}

/**
 * Detecta tendencia general basada en medias móviles
 * @param {number} price
 * @param {object} mas - { ma20, ma50, ma200 }
 * @returns {string}
 */
function detectMATrend(price, mas) {
  const { ma20, ma50, ma200 } = mas;

  if (!ma20 || !ma50) return 'unknown';

  // Alineación alcista: precio > ma20 > ma50 > ma200
  if (ma200 && price > ma20 && ma20 > ma50 && ma50 > ma200) return 'strong_uptrend';
  if (price > ma20 && ma20 > ma50) return 'uptrend';
  if (ma200 && price < ma20 && ma20 < ma50 && ma50 < ma200) return 'strong_downtrend';
  if (price < ma20 && ma20 < ma50) return 'downtrend';

  // Cruce de muerte / cruce dorado
  if (ma200 && ma50 > ma200 && price > ma50) return 'golden_cross_zone';
  if (ma200 && ma50 < ma200 && price < ma50) return 'death_cross_zone';

  return 'sideways';
}

/**
 * Calcula momentum (cambio % en N períodos)
 * @param {number[]} closes
 * @param {number} period
 * @returns {number|null}
 */
function calcMomentum(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return ((current - past) / past) * 100;
}

// ─── Análisis completo por token ───────────────────────────────────────────────

/**
 * Ejecuta análisis técnico completo para un token
 * @param {object} token - Token con ohlc y history
 * @returns {object}
 */
function analyzeToken(token) {
  const { id, symbol, name, currentPrice, change24h, volume24h } = token;

  if (!token.ohlc || token.ohlc.length < 10) {
    log.warn(`Datos OHLC insuficientes para ${symbol}`);
    return buildMinimalAnalysis(token);
  }

  log.info(`Analizando ${symbol} (${token.ohlc.length} velas OHLC)...`);

  const closes = token.ohlc.map(c => c.close);
  const volumes = token.history?.volumes?.map(v => v.volume) || [];

  // ─── Indicadores ──────────────────────────────────────────────────────────
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const bb = calcBollingerBands(closes);
  const atr = calcATR(token.ohlc);

  const ma20 = calcSMA(closes, 20);
  const ma50 = calcSMA(closes, 50);
  const ma200 = calcSMA(closes, 200);
  const ema20 = calcEMA(closes, 20);

  const momentum14 = calcMomentum(closes, 14);
  const momentum30 = calcMomentum(closes, 30);

  const volumeTrend = analyzeVolumeTrend(volumes);
  const breakout = detectBreakout(closes);
  const maTrend = detectMATrend(currentPrice, { ma20, ma50, ma200 });

  // ─── Señales consolidadas ─────────────────────────────────────────────────
  const signals = buildSignalSummary({
    rsi, macd, bb, maTrend, breakout, volumeTrend, momentum14, currentPrice, ma20, ma50,
  });

  // ─── Score técnico (0-100) ────────────────────────────────────────────────
  const technicalScore = computeTechnicalScore(signals);

  const analysis = {
    id,
    symbol,
    name,
    currentPrice,
    change24h,
    volume24h,
    indicators: {
      rsi,
      rsiSignal: rsi ? rsiSignal(rsi) : null,
      macd,
      bollingerBands: bb,
      atr,
      movingAverages: { ma20, ma50, ma200, ema20 },
      momentum: { period14: momentum14, period30: momentum30 },
    },
    volumeTrend,
    breakout,
    maTrend,
    signals,
    technicalScore,
    bias: technicalScore >= 65 ? 'bullish' : technicalScore <= 35 ? 'bearish' : 'neutral',
    analyzedAt: new Date().toISOString(),
  };

  log.info(`${symbol}: score=${technicalScore}, bias=${analysis.bias}, RSI=${rsi?.toFixed(1)}, trend=${maTrend}`);
  return analysis;
}

/**
 * Construye resumen de señales
 */
function buildSignalSummary({ rsi, macd, bb, maTrend, breakout, volumeTrend, momentum14, currentPrice, ma20, ma50 }) {
  const signals = [];

  if (rsi !== null) {
    if (rsi < 30) signals.push({ type: 'oversold', weight: 2, direction: 'bullish', detail: `RSI ${rsi.toFixed(1)} - oversold territory` });
    else if (rsi > 70) signals.push({ type: 'overbought', weight: 2, direction: 'bearish', detail: `RSI ${rsi.toFixed(1)} - overbought territory` });
    else if (rsi > 55) signals.push({ type: 'rsi_bullish', weight: 1, direction: 'bullish', detail: `RSI ${rsi.toFixed(1)} - bullish momentum` });
    else if (rsi < 45) signals.push({ type: 'rsi_bearish', weight: 1, direction: 'bearish', detail: `RSI ${rsi.toFixed(1)} - bearish momentum` });
  }

  if (macd) {
    if (macd.bullishCross) signals.push({ type: 'macd_bullish_cross', weight: 2, direction: 'bullish', detail: 'MACD histogram bullish crossover' });
    else if (macd.bearishCross) signals.push({ type: 'macd_bearish_cross', weight: 2, direction: 'bearish', detail: 'MACD histogram bearish crossover' });
    else if (macd.trend === 'bullish') signals.push({ type: 'macd_bullish', weight: 1, direction: 'bullish', detail: 'MACD above signal line' });
    else signals.push({ type: 'macd_bearish', weight: 1, direction: 'bearish', detail: 'MACD below signal line' });
  }

  if (['uptrend', 'strong_uptrend', 'golden_cross_zone'].includes(maTrend)) {
    signals.push({ type: 'ma_bullish', weight: maTrend.includes('strong') ? 2 : 1, direction: 'bullish', detail: `MA structure: ${maTrend}` });
  } else if (['downtrend', 'strong_downtrend', 'death_cross_zone'].includes(maTrend)) {
    signals.push({ type: 'ma_bearish', weight: maTrend.includes('strong') ? 2 : 1, direction: 'bearish', detail: `MA structure: ${maTrend}` });
  }

  if (breakout?.type === 'bullish_breakout') signals.push({ type: 'breakout_bullish', weight: 3, direction: 'bullish', detail: `Breakout above resistance: +${breakout.pctAbove?.toFixed(2)}%` });
  else if (breakout?.type === 'bearish_breakdown') signals.push({ type: 'breakdown_bearish', weight: 3, direction: 'bearish', detail: `Breakdown below support: -${breakout.pctBelow?.toFixed(2)}%` });

  if (volumeTrend.spike) signals.push({ type: 'volume_spike', weight: 2, direction: 'neutral', detail: `Volume ${volumeTrend.ratio?.toFixed(1)}x above average` });

  if (momentum14 !== null) {
    if (momentum14 > 20) signals.push({ type: 'strong_momentum', weight: 1, direction: 'bullish', detail: `14-period momentum: +${momentum14.toFixed(1)}%` });
    else if (momentum14 < -20) signals.push({ type: 'weak_momentum', weight: 1, direction: 'bearish', detail: `14-period momentum: ${momentum14.toFixed(1)}%` });
  }

  if (bb) {
    if (bb.squeezing) signals.push({ type: 'bb_squeeze', weight: 1, direction: 'neutral', detail: 'Bollinger Bands squeezing - volatility contraction' });
    if (bb.percentB > 0.95) signals.push({ type: 'bb_upper_touch', weight: 1, direction: 'bearish', detail: 'Price touching upper Bollinger Band' });
    else if (bb.percentB < 0.05) signals.push({ type: 'bb_lower_touch', weight: 1, direction: 'bullish', detail: 'Price touching lower Bollinger Band' });
  }

  return signals;
}

/**
 * Score técnico ponderado (0-100)
 */
function computeTechnicalScore(signals) {
  let bullishWeight = 0;
  let bearishWeight = 0;

  for (const signal of signals) {
    if (signal.direction === 'bullish') bullishWeight += signal.weight;
    else if (signal.direction === 'bearish') bearishWeight += signal.weight;
  }

  const total = bullishWeight + bearishWeight;
  if (total === 0) return 50;

  return Math.round((bullishWeight / total) * 100);
}

function buildMinimalAnalysis(token) {
  return {
    id: token.id,
    symbol: token.symbol,
    name: token.name,
    currentPrice: token.currentPrice,
    change24h: token.change24h,
    volume24h: token.volume24h,
    indicators: {},
    signals: [],
    technicalScore: 50,
    bias: 'neutral',
    maTrend: 'unknown',
    breakout: { type: null },
    volumeTrend: { trend: 'unknown' },
    analyzedAt: new Date().toISOString(),
    warning: 'Insufficient OHLC data',
  };
}

/**
 * Analiza todos los tokens del snapshot
 * @param {object} marketSnapshot
 * @returns {Array<object>}
 */
function analyzeAllTokens(marketSnapshot) {
  log.info(`Iniciando análisis técnico de ${marketSnapshot.tokens.length} tokens...`);
  const results = marketSnapshot.tokens.map(token => analyzeToken(token));
  log.info(`Análisis técnico completado para ${results.length} tokens`);
  return results;
}

module.exports = {
  calcRSI,
  calcMACD,
  calcSMA,
  calcEMA,
  calcBollingerBands,
  calcATR,
  analyzeVolumeTrend,
  detectBreakout,
  detectMATrend,
  calcMomentum,
  analyzeToken,
  analyzeAllTokens,
};
