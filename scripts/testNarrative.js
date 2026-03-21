'use strict';

/**
 * Test del módulo de detección de narrativas
 */

require('dotenv').config();

const { fetchNarrativeTweets } = require('../src/narrative/twitterScraper');
const { detectNarratives } = require('../src/narrative/narrativeDetector');
const { createModuleLogger } = require('../src/utils/logger');

const log = createModuleLogger('TestNarrative');

async function main() {
  console.log('\nTEST: Módulo de detección de narrativas\n');

  try {
    console.log('1. Fetching tweets...');
    const tweetData = await fetchNarrativeTweets();

    console.log(`Total tweets obtenidos: ${tweetData.tweets.length}`);
    console.log('Por query:');
    for (const [query, tweets] of Object.entries(tweetData.byQuery)) {
      if (tweets.length > 0) {
        console.log(`  "${query}": ${tweets.length} tweets`);
      }
    }

    console.log('\n2. Analizando narrativas...');
    const narrativeData = detectNarratives(tweetData);

    console.log(`\nSentimiento general: ${narrativeData.sentiment.label} (score: ${narrativeData.sentiment.score.toFixed(2)})`);
    console.log(`Distribución: ${narrativeData.sentiment.distribution.positive}% positivo / ${narrativeData.sentiment.distribution.negative}% negativo`);

    console.log('\nTop narrativas por score:');
    narrativeData.narrativeScores.slice(0, 6).forEach((n, i) => {
      console.log(`  ${i + 1}. ${n.narrative.padEnd(35)} | Score: ${String(n.score).padEnd(3)} | Tweets: ${n.tweetCount} | ${n.strength}`);
    });

    if (narrativeData.tokenMentions.length > 0) {
      console.log('\nTokens más mencionados:');
      narrativeData.tokenMentions.slice(0, 5).forEach(m => {
        console.log(`  ${m.symbol.padEnd(8)} | Menciones: ${m.count} | Avg Engagement: ${m.avgEngagement}`);
      });
    }

    if (narrativeData.emergingTopics.length > 0) {
      console.log('\nTérminos emergentes (últimas 12h):');
      narrativeData.emergingTopics.slice(0, 5).forEach(t => {
        console.log(`  "${t.term}" | Menciones recientes: ${t.recentCount} | Growth: ${(t.growthRate * 100).toFixed(0)}%`);
      });
    }

    if (narrativeData.topTerms.hashtags.length > 0) {
      console.log('\nHashtags top:');
      narrativeData.topTerms.hashtags.slice(0, 8).forEach(h => {
        process.stdout.write(`  #${h.tag}(${h.count})  `);
      });
      console.log();
    }

    console.log('\nInsights generados:');
    narrativeData.summary.insights.forEach(ins => {
      console.log(`  • ${ins}`);
    });

    console.log('\n✓ Test de narrativas completado exitosamente');
  } catch (err) {
    console.error(`✗ Error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
