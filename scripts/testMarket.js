'use strict';

/**
 * Test rápido del módulo de datos de mercado
 */

require('dotenv').config();

const { getFullMarketSnapshot } = require('../src/data/marketData');
const { analyzeAllTokens } = require('../src/data/technicalAnalysis');
const { createModuleLogger } = require('../src/utils/logger');
const { formatPrice, formatPct } = require('../src/utils/helpers');

const log = createModuleLogger('TestMarket');

async function main() {
  console.log('\nTEST: Módulo de datos de mercado\n');

  try {
    console.log('1. Obteniendo market snapshot...');
    const snapshot = await getFullMarketSnapshot();

    console.log(`\nTotal tokens en categoría AI: ${snapshot.totalTokensInCategory}`);
    console.log(`Tokens analizados: ${snapshot.tokens.length}`);
    console.log(`Market cap total: $${(snapshot.marketOverview.totalMarketCap / 1e9).toFixed(2)}B`);
    console.log(`Cambio promedio 24h: ${snapshot.marketOverview.avgChange24h?.toFixed(2)}%`);

    console.log('\nTop 5 tokens:');
    snapshot.tokens.slice(0, 5).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.symbol.padEnd(7)} | ${formatPrice(t.currentPrice).padEnd(15)} | ${formatPct(t.change24h || 0).padEnd(10)} | Vol: ${(t.volume24h / 1e6).toFixed(1)}M`);
    });

    console.log('\n2. Ejecutando análisis técnico...');
    const analyses = analyzeAllTokens(snapshot);

    console.log('\nAnálisis técnico completado:');
    analyses.slice(0, 5).forEach(t => {
      console.log(`  ${t.symbol.padEnd(7)} | RSI: ${(t.indicators?.rsi?.toFixed(1) || 'N/A').padEnd(6)} | Bias: ${t.bias.padEnd(8)} | Score: ${t.technicalScore}/100 | Trend: ${t.maTrend}`);
    });

    const bullish = analyses.filter(t => t.bias === 'bullish').length;
    const bearish = analyses.filter(t => t.bias === 'bearish').length;
    console.log(`\nDistribución: ${bullish} alcistas, ${bearish} bajistas, ${analyses.length - bullish - bearish} neutros`);

    const breakouts = analyses.filter(t => t.breakout?.type === 'bullish_breakout');
    if (breakouts.length) {
      console.log(`\nBreakouts detectados: ${breakouts.map(t => t.symbol).join(', ')}`);
    }

    const oversold = analyses.filter(t => t.indicators?.rsi && t.indicators.rsi < 30);
    if (oversold.length) {
      console.log(`Oversold (RSI<30): ${oversold.map(t => `${t.symbol}(${t.indicators.rsi.toFixed(1)})`).join(', ')}`);
    }

    console.log('\n✓ Test de mercado completado exitosamente');
  } catch (err) {
    console.error(`✗ Error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
