'use strict';

const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { createCanvas } = require('canvas');
const fs = require('fs-extra');
const path = require('path');
const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { formatPrice, formatPct, todayISO } = require('../utils/helpers');

const log = createModuleLogger('ImageGenerator');

// ─── Configuración de canvas ───────────────────────────────────────────────────

const CHART_WIDTH = config.images.width;   // 1200
const CHART_HEIGHT = config.images.height; // 675

// Paleta de colores profesional
const COLORS = {
  background: '#0d1117',
  cardBg: '#161b22',
  border: '#30363d',
  text: '#c9d1d9',
  textDim: '#8b949e',
  accent: '#58a6ff',
  green: '#3fb950',
  red: '#f85149',
  orange: '#d29922',
  purple: '#bc8cff',
  teal: '#39d0d8',
  grid: '#21262d',
  white: '#ffffff',
};

// Asegurar directorio de imágenes
async function ensureImageDir() {
  await fs.ensureDir(config.images.outputDir);
}

// ─── Gráfico de precio + medias móviles ───────────────────────────────────────

/**
 * Genera gráfico de precio con medias móviles para un token
 * @param {object} token - Token con OHLC y análisis técnico
 * @param {object} analysis - Análisis técnico
 * @returns {Promise<string>} - Ruta del archivo generado
 */
async function generatePriceChart(token, analysis) {
  await ensureImageDir();

  if (!token.ohlc || token.ohlc.length < 20) {
    log.warn(`OHLC insuficiente para gráfico de ${token.symbol}`);
    return null;
  }

  log.info(`Generando gráfico de precio para ${token.symbol}...`);

  const recentOHLC = token.ohlc.slice(-60); // últimas 60 velas
  const labels = recentOHLC.map(c => {
    const d = new Date(c.timestamp);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });
  const closes = recentOHLC.map(c => c.close);

  // Calcular MAs sobre los datos
  const ma20 = computeMA(closes, 20);
  const ma50 = computeMA(closes, 50);

  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: COLORS.background });

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${token.symbol} Price`,
          data: closes,
          borderColor: COLORS.accent,
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
          tension: 0.1,
          order: 1,
        },
        {
          label: 'MA20',
          data: ma20,
          borderColor: COLORS.orange,
          borderWidth: 1.5,
          pointRadius: 0,
          borderDash: [],
          fill: false,
          tension: 0.1,
          order: 2,
        },
        {
          label: 'MA50',
          data: ma50,
          borderColor: COLORS.purple,
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.1,
          order: 3,
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: COLORS.textDim,
            font: { size: 14, family: 'monospace' },
            boxWidth: 20,
            padding: 20,
          },
        },
        title: {
          display: true,
          text: [
            `${token.symbol} / USD — Price + Moving Averages`,
            `RSI(14): ${analysis?.indicators?.rsi?.toFixed(1) || 'N/A'} | Bias: ${analysis?.bias?.toUpperCase() || 'N/A'} | Score: ${analysis?.technicalScore || 'N/A'}/100`,
          ],
          color: COLORS.white,
          font: { size: 16, family: 'monospace', weight: 'bold' },
          padding: { top: 20, bottom: 10 },
        },
      },
      scales: {
        x: {
          grid: { color: COLORS.grid },
          ticks: {
            color: COLORS.textDim,
            maxTicksLimit: 12,
            font: { size: 11, family: 'monospace' },
          },
        },
        y: {
          grid: { color: COLORS.grid },
          ticks: {
            color: COLORS.textDim,
            font: { size: 11, family: 'monospace' },
            callback: val => formatPrice(val),
          },
          position: 'right',
        },
      },
      layout: {
        padding: { top: 10, right: 20, bottom: 20, left: 20 },
      },
    },
  };

  const imageBuffer = await chartJSNodeCanvas.renderToBuffer(chartConfig);
  const filename = `chart_${token.symbol.toLowerCase()}_${todayISO()}.png`;
  const filepath = path.join(config.images.outputDir, filename);
  await fs.writeFile(filepath, imageBuffer);

  log.info(`Gráfico guardado: ${filepath}`);
  return filepath;
}

// ─── Visual card de insight ────────────────────────────────────────────────────

/**
 * Genera una tarjeta visual con el insight del tweet
 * @param {object} tweetData - { content, type, token }
 * @param {object} tokenData - Datos del token (opcional)
 * @returns {Promise<string>} - Ruta del archivo
 */
async function generateInsightCard(tweetData, tokenData = null) {
  await ensureImageDir();

  log.info(`Generando insight card para tipo: ${tweetData.type}...`);

  const canvas = createCanvas(CHART_WIDTH, CHART_HEIGHT);
  const ctx = canvas.getContext('2d');

  // ─── Background ─────────────────────────────────────────────────────────────
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, CHART_WIDTH, CHART_HEIGHT);

  // ─── Border decorativo ───────────────────────────────────────────────────────
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(20, 20, CHART_WIDTH - 40, CHART_HEIGHT - 40);

  // ─── Línea de acento superior ────────────────────────────────────────────────
  const accentColor = getTypeColor(tweetData.type);
  ctx.fillStyle = accentColor;
  ctx.fillRect(20, 20, CHART_WIDTH - 40, 4);

  // ─── Header ─────────────────────────────────────────────────────────────────
  ctx.fillStyle = COLORS.textDim;
  ctx.font = 'bold 20px monospace';
  ctx.fillText(getTypeLabel(tweetData.type), 50, 70);

  // Fecha
  ctx.fillStyle = COLORS.textDim;
  ctx.font = '18px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(todayISO(), CHART_WIDTH - 50, 70);
  ctx.textAlign = 'left';

  // ─── Línea separadora ────────────────────────────────────────────────────────
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(50, 90);
  ctx.lineTo(CHART_WIDTH - 50, 90);
  ctx.stroke();

  // ─── Contenido del tweet ─────────────────────────────────────────────────────
  ctx.fillStyle = COLORS.white;
  ctx.font = 'bold 26px serif';
  const wrappedText = wrapText(ctx, tweetData.content, CHART_WIDTH - 100, 28);
  let textY = 150;
  for (const line of wrappedText) {
    ctx.fillText(line, 50, textY);
    textY += 38;
  }

  // ─── Datos del token (si disponibles) ────────────────────────────────────────
  if (tokenData) {
    const dataY = CHART_HEIGHT - 160;

    // Card de datos
    ctx.fillStyle = COLORS.cardBg;
    ctx.roundRect(50, dataY, CHART_WIDTH - 100, 100, 8);
    ctx.fill();
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    const isUp = (tokenData.change24h || 0) >= 0;

    ctx.font = 'bold 28px monospace';
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(tokenData.symbol, 80, dataY + 45);

    ctx.font = '24px monospace';
    ctx.fillStyle = COLORS.white;
    ctx.fillText(formatPrice(tokenData.currentPrice), 80, dataY + 80);

    ctx.font = 'bold 24px monospace';
    ctx.fillStyle = isUp ? COLORS.green : COLORS.red;
    ctx.fillText(formatPct(tokenData.change24h || 0), 300, dataY + 45);

    if (tokenData.rsi) {
      ctx.font = '20px monospace';
      ctx.fillStyle = COLORS.textDim;
      ctx.fillText(`RSI: ${tokenData.rsi.toFixed(1)}`, 500, dataY + 45);
      ctx.fillText(`Score: ${tokenData.technicalScore || 'N/A'}/100`, 500, dataY + 75);
    }

    if (tokenData.maTrend) {
      ctx.font = '18px monospace';
      ctx.fillStyle = COLORS.textDim;
      ctx.fillText(tokenData.maTrend.replace(/_/g, ' '), 700, dataY + 55);
    }
  }

  // ─── Watermark ───────────────────────────────────────────────────────────────
  ctx.fillStyle = COLORS.textDim;
  ctx.font = '14px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('AI CRYPTO ANALYST | Data-Driven Insights', CHART_WIDTH / 2, CHART_HEIGHT - 25);
  ctx.textAlign = 'left';

  // ─── Guardar ─────────────────────────────────────────────────────────────────
  const filename = `card_${tweetData.type}_${Date.now()}.png`;
  const filepath = path.join(config.images.outputDir, filename);
  const buffer = canvas.toBuffer('image/png');
  await fs.writeFile(filepath, buffer);

  log.info(`Insight card guardada: ${filepath}`);
  return filepath;
}

// ─── Mapa de narrativas ────────────────────────────────────────────────────────

/**
 * Genera una visualización de narrativas y sus scores
 * @param {Array} narrativeScores
 * @returns {Promise<string>}
 */
async function generateNarrativeMap(narrativeScores) {
  await ensureImageDir();

  log.info('Generando mapa de narrativas...');

  const canvas = createCanvas(CHART_WIDTH, CHART_HEIGHT);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, CHART_WIDTH, CHART_HEIGHT);

  // Header
  ctx.fillStyle = COLORS.white;
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('AI CRYPTO NARRATIVE STRENGTH', CHART_WIDTH / 2, 55);

  ctx.fillStyle = COLORS.textDim;
  ctx.font = '18px monospace';
  ctx.fillText(todayISO(), CHART_WIDTH / 2, 85);
  ctx.textAlign = 'left';

  // Línea separadora
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(50, 100);
  ctx.lineTo(CHART_WIDTH - 50, 100);
  ctx.stroke();

  // Barras de narrativas
  const top8 = narrativeScores.slice(0, 8);
  const barAreaHeight = CHART_HEIGHT - 180;
  const barHeight = Math.min(55, (barAreaHeight / top8.length) - 10);
  const barMaxWidth = CHART_WIDTH - 350;

  top8.forEach((narrative, i) => {
    const y = 120 + i * (barHeight + 15);
    const barWidth = (narrative.score / 100) * barMaxWidth;
    const barColor = getScoreColor(narrative.score);

    // Bar background
    ctx.fillStyle = COLORS.cardBg;
    ctx.fillRect(240, y, barMaxWidth, barHeight);

    // Bar fill
    ctx.fillStyle = barColor;
    ctx.fillRect(240, y, barWidth, barHeight);

    // Label
    ctx.fillStyle = COLORS.text;
    ctx.font = `bold ${barHeight >= 45 ? 16 : 13}px monospace`;
    ctx.textAlign = 'right';
    const labelText = narrative.narrative.length > 28
      ? narrative.narrative.slice(0, 26) + '..'
      : narrative.narrative;
    ctx.fillText(labelText, 230, y + barHeight / 2 + 6);

    // Score value
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.white;
    ctx.font = 'bold 16px monospace';
    ctx.fillText(`${narrative.score}`, 240 + barWidth + 10, y + barHeight / 2 + 6);

    // Strength badge
    ctx.fillStyle = COLORS.textDim;
    ctx.font = '14px monospace';
    ctx.fillText(`${narrative.tweetCount}tw`, CHART_WIDTH - 100, y + barHeight / 2 + 6);
    ctx.textAlign = 'left';
  });

  // Watermark
  ctx.fillStyle = COLORS.textDim;
  ctx.font = '13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('AI CRYPTO ANALYST | Narrative Intelligence', CHART_WIDTH / 2, CHART_HEIGHT - 20);

  const filename = `narrative_map_${todayISO()}.png`;
  const filepath = path.join(config.images.outputDir, filename);
  await fs.writeFile(filepath, canvas.toBuffer('image/png'));

  log.info(`Mapa de narrativas guardado: ${filepath}`);
  return filepath;
}

// ─── Selector automático de imagen para tweet ─────────────────────────────────

/**
 * Genera la imagen más apropiada para un tweet dado
 * @param {object} tweet - Tweet generado
 * @param {object} fusionData - Datos de fusión
 * @returns {Promise<string|null>} - Ruta de la imagen
 */
async function selectAndGenerateImage(tweet, fusionData) {
  try {
    const { type } = tweet;
    const tokens = fusionData.tokens || [];

    if (type === 'technical_analysis' || type === 'market_insight') {
      const focusSymbol = extractTokenFromTweet(tweet.content, tokens);
      const token = tokens.find(t => t.symbol === focusSymbol) || tokens[0];

      if (token) {
        // Intentar gráfico de precio primero
        const marketToken = fusionData.marketSnapshot?.tokens?.find(t => t.symbol === token.symbol);
        if (marketToken?.ohlc?.length >= 20) {
          return await generatePriceChart(marketToken, token);
        }
        // Fallback a insight card
        return await generateInsightCard(tweet, token);
      }
    }

    if (type === 'narrative_insight' || type === 'system_thinking') {
      if (fusionData.narrativeSummary?.leadingNarratives) {
        return await generateNarrativeMap(fusionData.aiNarrativeAnalysis?.narrativeScores || []);
      }
    }

    // Para todos los demás tipos, generar insight card
    const focusToken = tokens[0];
    return await generateInsightCard(tweet, focusToken);

  } catch (err) {
    log.error(`Error generando imagen para tweet ${tweet.type}: ${err.message}`);
    return null;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function computeMA(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    const slice = data.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

function wrapText(ctx, text, maxWidth, lineHeight) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

function getTypeLabel(type) {
  const labels = {
    market_insight: 'MARKET INSIGHT',
    technical_analysis: 'TECHNICAL ANALYSIS',
    narrative_insight: 'NARRATIVE INTELLIGENCE',
    contrarian: 'CONTRARIAN VIEW',
    system_thinking: 'SYSTEMS ANALYSIS',
    divergence: 'DIVERGENCE SIGNAL',
  };
  return labels[type] || 'ANALYSIS';
}

function getTypeColor(type) {
  const colors = {
    market_insight: COLORS.accent,
    technical_analysis: COLORS.green,
    narrative_insight: COLORS.purple,
    contrarian: COLORS.orange,
    system_thinking: COLORS.teal,
    divergence: COLORS.red,
  };
  return colors[type] || COLORS.accent;
}

function getScoreColor(score) {
  if (score >= 70) return COLORS.green;
  if (score >= 45) return COLORS.accent;
  if (score >= 25) return COLORS.orange;
  return COLORS.textDim;
}

function extractTokenFromTweet(content, tokens) {
  const contentUpper = content.toUpperCase();
  for (const token of tokens) {
    if (contentUpper.includes(token.symbol)) return token.symbol;
  }
  return null;
}

module.exports = {
  generatePriceChart,
  generateInsightCard,
  generateNarrativeMap,
  selectAndGenerateImage,
};
