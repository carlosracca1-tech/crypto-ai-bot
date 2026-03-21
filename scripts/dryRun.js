'use strict';

/**
 * DRY RUN - Ejecuta el pipeline completo sin publicar nada en Twitter
 * Útil para revisar el contenido generado antes de activar el bot
 */

require('dotenv').config();
process.env.DRY_RUN = 'true';

const { runPipeline } = require('../src/pipeline');
const { createModuleLogger } = require('../src/utils/logger');

const log = createModuleLogger('DryRun');

async function main() {
  log.info('══════════════════════════════════════════');
  log.info('        DRY RUN MODE - NO POSTING         ');
  log.info('══════════════════════════════════════════');

  try {
    const result = await runPipeline({
      dryRun: true,
      forceRun: true,
      skipPosting: true,
    });

    if (!result) {
      log.info('No result returned');
      return;
    }

    const { fusionData, generatedContent } = result;

    // ─── Imprimir resumen de mercado ───────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('RESUMEN DE MERCADO AI');
    console.log('═══════════════════════════════════════════════════════════');

    const { macroSignals, tokens } = fusionData;
    console.log(`Fase de mercado: ${macroSignals.marketPhase}`);
    console.log(`Sentimiento: ${macroSignals.overallSentiment} (${macroSignals.sentimentScore})`);
    console.log(`Cambio promedio 24h: ${macroSignals.avgChange24h}%`);
    console.log(`Tokens alcistas/bajistas: ${macroSignals.bullishTokenCount}/${macroSignals.bearishTokenCount}`);
    console.log(`Narrativa dominante: ${macroSignals.dominantNarrative} (${macroSignals.narrativeStrength})`);

    console.log('\nTop 5 Tokens por Score Compuesto:');
    tokens.slice(0, 5).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.symbol.padEnd(6)} | Score: ${String(t.compositeScore).padEnd(3)}/100 | RSI: ${t.rsi?.toFixed(1) || 'N/A'} | Bias: ${t.technicalBias} | ${t.maTrend?.replace(/_/g, ' ')}`);
    });

    // ─── Imprimir tweets generados ────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('TWEETS GENERADOS');
    console.log('═══════════════════════════════════════════════════════════');

    generatedContent.tweets.forEach((tweet, i) => {
      console.log(`\n[TWEET ${i + 1}/${generatedContent.tweets.length}]`);
      console.log(`Tipo: ${tweet.type}`);
      console.log(`Caracteres: ${tweet.content.length}/280`);
      console.log('─'.repeat(60));
      console.log(tweet.content);
      console.log('─'.repeat(60));
    });

    // ─── Imprimir thread si existe ────────────────────────────────────────────
    if (generatedContent.thread) {
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log('THREAD GENERADO');
      console.log('═══════════════════════════════════════════════════════════');

      generatedContent.thread.tweets.forEach((t, i) => {
        console.log(`\n[${i + 1}/${generatedContent.thread.tweetCount}] (${t.type})`);
        console.log(t.tweet);
      });
    }

    // ─── Insights de narrativas ────────────────────────────────────────────────
    if (fusionData.aiNarrativeAnalysis?.keyInsights?.length) {
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log('INSIGHTS DE NARRATIVA (GPT)');
      console.log('═══════════════════════════════════════════════════════════');
      fusionData.aiNarrativeAnalysis.keyInsights.forEach((insight, i) => {
        console.log(`${i + 1}. ${insight}`);
      });
    }

    console.log('\n══════════════════════════════════════════');
    console.log('DRY RUN COMPLETADO. Todo listo para producción.');
    console.log('Usa: npm run pipeline para publicar');
    console.log('══════════════════════════════════════════\n');

  } catch (err) {
    log.error(`Error en dry run: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
