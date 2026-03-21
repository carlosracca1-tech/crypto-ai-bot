'use strict';

/**
 * Chart Generator — Canvas-based price charts for Twitter
 *
 * Generates a 1200×680 dark-theme chart with:
 *  - Candlestick price panel (top 60%) with MA20, MA50, S/R zones
 *  - RSI panel (bottom 30%)
 *  - Header with token name, price, 24h change
 *
 * Saves to data/charts/{symbol}_{date}.png and returns the file path.
 */

const { createCanvas } = require('canvas');
const path  = require('path');
const fs    = require('fs');
const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('ChartGenerator');

// ─── Layout constants ──────────────────────────────────────────────────────────

const W = 1200;
const H = 680;

const ML = 72;   // margin left  (for price labels)
const MR = 20;   // margin right
const MT = 54;   // margin top   (for header)
const MB = 28;   // margin bottom (for date labels)

const PRICE_H  = 380;  // price panel height
const GAP      = 18;   // gap between panels
const RSI_H    = 160;  // RSI panel height

// Derived Y-starts
const PRICE_Y = MT;
const RSI_Y   = PRICE_Y + PRICE_H + GAP;

const CHART_W = W - ML - MR;

const CANDLES = 45;   // candles to show

// ─── Dark-theme palette ───────────────────────────────────────────────────────

const C = {
  bg:          '#0d1117',
  grid:        '#1e2634',
  border:      '#30363d',
  text:        '#8b949e',
  textBright:  '#e6edf3',
  bull:        '#26a69a',
  bear:        '#ef5350',
  ma20:        '#ff9800',
  ma50:        '#4caf50',
  rsiLine:     '#b39ddb',
  rsiOB:       'rgba(239,83,80,0.12)',
  rsiOS:       'rgba(38,166,154,0.12)',
  support:     'rgba(38,166,154,0.18)',
  resistance:  'rgba(239,83,80,0.18)',
  watermark:   'rgba(139,148,158,0.25)',
};

// ─── Indicator helpers ────────────────────────────────────────────────────────

/** Simple Moving Average — returns full series (null for warm-up period) */
function smaArray(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += closes[i - j];
    out[i] = sum / period;
  }
  return out;
}

/** RSI(14) — returns full series */
function rsiArray(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmtPrice(p) {
  if (!p || isNaN(p)) return '$0';
  if (p >= 10000) return `$${(p / 1000).toFixed(1)}k`;
  if (p >= 1)     return `$${p.toFixed(2)}`;
  if (p >= 0.01)  return `$${p.toFixed(4)}`;
  return `$${p.toFixed(6)}`;
}

function fmtDate(ts) {
  const d = new Date(typeof ts === 'number' && ts < 2e11 ? ts * 1000 : ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ─── Core chart renderer ──────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array<{timestamp,open,high,low,close}>} opts.ohlc
 * @param {string}  opts.symbol
 * @param {number}  opts.currentPrice
 * @param {number}  opts.change24h
 * @param {object}  [opts.breakout]   - { support, resistance }
 * @param {string}  [opts.outputDir]
 * @returns {Promise<string|null>}
 */
async function generateChart({ ohlc, symbol, currentPrice, change24h, breakout = {}, outputDir }) {
  if (!ohlc || ohlc.length < 20) {
    log.warn(`${symbol}: datos OHLC insuficientes (${ohlc?.length || 0} velas)`);
    return null;
  }

  // Slice to visible candles; keep full history for indicators
  const data      = ohlc.slice(-CANDLES);
  const allCloses = ohlc.map(c => c.close);
  const sliceFrom = ohlc.length - data.length;

  const allMa20 = smaArray(allCloses, 20);
  const allMa50 = smaArray(allCloses, 50);
  const allRsi  = rsiArray(allCloses, 14);

  const ma20s = allMa20.slice(sliceFrom);
  const ma50s = allMa50.slice(sliceFrom);
  const rsiS  = allRsi.slice(sliceFrom);

  // ─── Canvas setup ──────────────────────────────────────────────────────────
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // ─── Coordinate helpers ────────────────────────────────────────────────────
  const highs = data.map(c => c.high);
  const lows  = data.map(c => c.low);
  const mas   = [...ma20s, ...ma50s].filter(v => v !== null);

  const priceMin = Math.min(...lows,  ...mas) * 0.9975;
  const priceMax = Math.max(...highs, ...mas) * 1.0025;
  const priceRng = priceMax - priceMin;

  const cSpacing = CHART_W / data.length;
  const cWidth   = Math.max(2, Math.floor(cSpacing * 0.65));

  function cx(i)  { return ML + i * cSpacing + (cSpacing - cWidth) / 2; }
  function cMid(i){ return cx(i) + cWidth / 2; }

  function py(p)  { return PRICE_Y + PRICE_H - ((p - priceMin) / priceRng) * PRICE_H; }
  function ry(r)  { return RSI_Y   + RSI_H   - (r / 100) * RSI_H; }

  // ─── PRICE PANEL — grid ────────────────────────────────────────────────────
  ctx.strokeStyle = C.grid;
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 5]);

  const GRID_LINES = 5;
  for (let i = 0; i <= GRID_LINES; i++) {
    const p = priceMin + (priceRng * i) / GRID_LINES;
    const y = py(p);
    ctx.beginPath();
    ctx.moveTo(ML, y);
    ctx.lineTo(ML + CHART_W, y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle  = C.text;
    ctx.font       = '11px monospace';
    ctx.textAlign  = 'right';
    ctx.fillText(fmtPrice(p), ML - 6, y + 4);
    ctx.setLineDash([4, 5]);
  }
  ctx.setLineDash([]);

  // ─── SUPPORT / RESISTANCE zones ───────────────────────────────────────────
  function drawZone(level, color, fillColor, label) {
    if (!level || level < priceMin || level > priceMax) return;
    const y = py(level);

    ctx.fillStyle = fillColor;
    ctx.fillRect(ML, y - 4, CHART_W, 8);

    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(ML, y);
    ctx.lineTo(ML + CHART_W, y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle  = color;
    ctx.font       = '10px monospace';
    ctx.textAlign  = 'right';
    ctx.fillText(`${label} ${fmtPrice(level)}`, ML + CHART_W - 4, y - 6);
  }

  drawZone(breakout.support,    C.bull, C.support,    'S');
  drawZone(breakout.resistance, C.bear, C.resistance, 'R');

  // ─── CANDLESTICKS ──────────────────────────────────────────────────────────
  for (let i = 0; i < data.length; i++) {
    const d   = data[i];
    const x   = cx(i);
    const mid = cMid(i);
    const isBull = d.close >= d.open;
    const color  = isBull ? C.bull : C.bear;

    // Wick
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(mid, py(d.high));
    ctx.lineTo(mid, py(d.low));
    ctx.stroke();

    // Body
    const bodyTop = py(Math.max(d.open, d.close));
    const bodyBot = py(Math.min(d.open, d.close));
    const bodyH   = Math.max(1, bodyBot - bodyTop);

    ctx.fillStyle = color;
    ctx.fillRect(x, bodyTop, cWidth, bodyH);
  }

  // ─── MA LINES ─────────────────────────────────────────────────────────────
  function drawMA(series, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < series.length; i++) {
      if (series[i] === null) continue;
      const x = cMid(i);
      const y = py(series[i]);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  drawMA(ma20s, C.ma20);
  drawMA(ma50s, C.ma50);

  // Price panel border
  ctx.strokeStyle = C.border;
  ctx.lineWidth   = 1;
  ctx.strokeRect(ML, PRICE_Y, CHART_W, PRICE_H);

  // ─── RSI PANEL ────────────────────────────────────────────────────────────
  // OB / OS zones
  ctx.fillStyle = C.rsiOB;
  ctx.fillRect(ML, ry(100), CHART_W, ry(70) - ry(100));
  ctx.fillStyle = C.rsiOS;
  ctx.fillRect(ML, ry(30),  CHART_W, ry(0)  - ry(30));

  // Grid at 30 / 50 / 70
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = C.grid;
  ctx.lineWidth   = 1;

  for (const level of [30, 50, 70]) {
    const y = ry(level);
    ctx.beginPath();
    ctx.moveTo(ML, y);
    ctx.lineTo(ML + CHART_W, y);
    ctx.stroke();

    ctx.fillStyle = C.text;
    ctx.font      = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(level, ML - 6, y + 3);
  }
  ctx.setLineDash([]);

  // RSI line
  ctx.strokeStyle = C.rsiLine;
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  let rsiStarted = false;
  for (let i = 0; i < rsiS.length; i++) {
    if (rsiS[i] === null) continue;
    const x = cMid(i);
    const y = ry(rsiS[i]);
    if (!rsiStarted) { ctx.moveTo(x, y); rsiStarted = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // RSI label + current value
  const lastRsi = rsiS.filter(v => v !== null).pop();
  ctx.font      = 'bold 11px monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = C.rsiLine;
  ctx.fillText('RSI(14)', ML + 5, RSI_Y + 14);

  if (lastRsi !== undefined) {
    const rc = lastRsi > 70 ? C.bear : lastRsi < 30 ? C.bull : C.rsiLine;
    ctx.fillStyle = rc;
    ctx.font      = 'bold 12px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(lastRsi.toFixed(1), ML + CHART_W - 5, RSI_Y + 14);
  }

  // RSI panel border
  ctx.strokeStyle = C.border;
  ctx.lineWidth   = 1;
  ctx.strokeRect(ML, RSI_Y, CHART_W, RSI_H);

  // ─── DATE LABELS ──────────────────────────────────────────────────────────
  const labelEvery = Math.max(1, Math.floor(data.length / 7));
  ctx.fillStyle  = C.text;
  ctx.font       = '10px monospace';
  ctx.textAlign  = 'center';
  for (let i = 0; i < data.length; i += labelEvery) {
    ctx.fillText(fmtDate(data[i].timestamp), cMid(i), RSI_Y + RSI_H + 16);
  }

  // ─── HEADER ───────────────────────────────────────────────────────────────
  // Symbol
  ctx.fillStyle = C.textBright;
  ctx.font      = 'bold 24px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(symbol.toUpperCase(), ML, 38);
  const symW = ctx.measureText(symbol.toUpperCase()).width;

  // Price
  ctx.font      = 'bold 20px monospace';
  ctx.fillStyle = C.textBright;
  const priceStr = fmtPrice(currentPrice);
  ctx.fillText(priceStr, ML + symW + 14, 38);
  const priceW = ctx.measureText(priceStr).width;

  // 24h change
  const ch = change24h || 0;
  ctx.fillStyle = ch >= 0 ? C.bull : C.bear;
  ctx.font      = 'bold 16px monospace';
  ctx.fillText(`${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`, ML + symW + priceW + 24, 38);

  // Legend
  const legX = ML + CHART_W - 170;
  ctx.fillStyle = C.ma20;
  ctx.fillRect(legX, 26, 22, 3);
  ctx.fillStyle  = C.text;
  ctx.font       = '11px monospace';
  ctx.textAlign  = 'left';
  ctx.fillText('MA20', legX + 26, 32);

  ctx.fillStyle = C.ma50;
  ctx.fillRect(legX + 88, 26, 22, 3);
  ctx.fillStyle = C.text;
  ctx.fillText('MA50', legX + 114, 32);

  // Watermark
  ctx.fillStyle  = C.watermark;
  ctx.font       = '11px monospace';
  ctx.textAlign  = 'right';
  ctx.fillText('@TheProtocoMind', ML + CHART_W, H - 7);

  // ─── Save file ─────────────────────────────────────────────────────────────
  const dir = path.resolve(outputDir || path.join(process.cwd(), 'data', 'charts'));
  fs.mkdirSync(dir, { recursive: true });

  const dateStr  = new Date().toISOString().split('T')[0];
  const filename = `${symbol.toLowerCase()}_${dateStr}.png`;
  const filePath = path.join(dir, filename);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(filePath, buf);

  log.info(`Chart guardado: ${filePath} (${(buf.length / 1024).toFixed(0)} KB)`);
  return filePath;
}

// ─── Convenience wrapper (from fusionData) ────────────────────────────────────

/**
 * Generate chart for the focus/technical token from pipeline fusionData.
 * @param {object} fusionData
 * @param {string|null} tokenSymbol  - Optional override; defaults to focus token
 * @returns {Promise<string|null>}
 */
async function generateChartForToken(fusionData, tokenSymbol = null) {
  try {
    const mktTokens  = fusionData.marketSnapshot?.tokens || [];
    const focusSym   = tokenSymbol
      || fusionData.contentInsights?.technicalInsight?.focusToken
      || mktTokens[0]?.symbol;

    const mktToken   = mktTokens.find(t => t.symbol === focusSym) || mktTokens[0];
    if (!mktToken) {
      log.warn('generateChartForToken: no hay token disponible');
      return null;
    }

    // Breakout levels from fusionData.tokens (has computed indicators)
    const fusionTok  = (fusionData.tokens || []).find(t => t.symbol === mktToken.symbol) || {};
    const breakout   = fusionTok.breakout || mktToken.breakout || {};

    return await generateChart({
      ohlc:         mktToken.ohlc,
      symbol:       mktToken.symbol,
      currentPrice: mktToken.currentPrice,
      change24h:    mktToken.change24h,
      breakout,
      outputDir:    path.join(process.cwd(), 'data', 'charts'),
    });
  } catch (err) {
    log.error(`Error en generateChartForToken: ${err.message}`);
    return null;
  }
}

module.exports = { generateChart, generateChartForToken };
