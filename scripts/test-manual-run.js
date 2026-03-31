#!/usr/bin/env node
/**
 * TEST MANUAL: Verifica que las guardias bloquean reads Y que el pipeline
 * puede generar contenido sin tocar Twitter API.
 *
 * Uso: node scripts/test-manual-run.js
 *
 * NO gasta créditos de Twitter. Es 100% seguro correrlo.
 */

// Force reads disabled (should already be true in .env)
process.env.TWITTER_READS_DISABLED = 'true';
process.env.DRY_RUN = 'true';  // No publicar nada

const { config } = require('../src/config');

console.log('\n========================================');
console.log('  TEST MANUAL — Verificación de guardias');
console.log('========================================\n');

// 1. Verificar config
console.log('1️⃣  CONFIGURACIÓN:');
console.log(`   TWITTER_READS_DISABLED = ${config.twitter.readsDisabled}`);
console.log(`   DRY_RUN = ${config.content.dryRun}`);

if (!config.twitter.readsDisabled) {
  console.log('\n❌ ERROR: readsDisabled es FALSE. Las guardias no van a funcionar.');
  console.log('   Revisá tu .env — necesitás: TWITTER_READS_DISABLED=true');
  process.exit(1);
}
console.log('   ✅ Reads bloqueadas correctamente\n');

// 2. Interceptar fetch para detectar leaks
let twitterCallsDetected = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(url, ...args) {
  const urlStr = String(url);
  if (urlStr.includes('api.twitter.com') || urlStr.includes('api.x.com')) {
    twitterCallsDetected++;
    console.log(`   🚨 LEAK DETECTADO: ${urlStr}`);
    throw new Error('BLOCKED BY TEST — Twitter API call detected');
  }
  return originalFetch.call(this, url, ...args);
};

async function runTest() {
  // 3. Testear cada módulo individualmente
  console.log('2️⃣  TESTEANDO MÓDULOS (ninguno debería llamar a Twitter):');

  const tests = [
    {
      name: 'twitterClient.searchTweetsForToken',
      fn: async () => {
        const { searchTweetsForToken } = require('../src/twitter/twitterClient');
        return await searchTweetsForToken('BTC');
      }
    },
    {
      name: 'twitterClient.verifyCredentials',
      fn: async () => {
        const { verifyCredentials } = require('../src/twitter/twitterClient');
        return await verifyCredentials();
      }
    },
    {
      name: 'twitterScraper.searchRecentTweets',
      fn: async () => {
        const { searchRecentTweets } = require('../src/narrative/twitterScraper');
        return await searchRecentTweets('AI crypto test');
      }
    },
    {
      name: 'lightEngagement.runLightEngagement',
      fn: async () => {
        const { runLightEngagement } = require('../src/engagement/lightEngagement');
        return await runLightEngagement({ dryRun: true });
      }
    },
    {
      name: 'performanceEngine.fetchTweetMetrics',
      fn: async () => {
        const { fetchTweetMetrics } = require('../src/performance/performanceEngine');
        return await fetchTweetMetrics(['123456']);
      }
    },
    {
      name: 'liveAdjuster.runLiveAdjuster',
      fn: async () => {
        const { runLiveAdjuster } = require('../src/performance/liveAdjuster');
        return await runLiveAdjuster();
      }
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const result = await test.fn();
      console.log(`   ✅ ${test.name} — bloqueado OK`);
      passed++;
    } catch (err) {
      if (err.message.includes('BLOCKED BY TEST')) {
        console.log(`   ❌ ${test.name} — LEAK! Intentó llamar a Twitter`);
        failed++;
      } else {
        // Other errors are fine — means it didn't reach Twitter
        console.log(`   ✅ ${test.name} — bloqueado OK (error no-twitter: ${err.message.slice(0, 60)})`);
        passed++;
      }
    }
  }

  // 4. Resumen
  console.log('\n========================================');
  console.log('  RESULTADO');
  console.log('========================================');
  console.log(`   Módulos testeados: ${tests.length}`);
  console.log(`   Bloqueados OK:     ${passed}`);
  console.log(`   Leaks detectados:  ${failed}`);
  console.log(`   Twitter API calls: ${twitterCallsDetected}`);

  if (failed === 0 && twitterCallsDetected === 0) {
    console.log('\n   ✅ TODO OK — El pipeline NO va a gastar créditos de Twitter');
    console.log('   Tu costo en Twitter API será: $0.00/día');
    console.log('\n   Ahora podés hacer: git push origin main');
    console.log('   Railway va a re-deployar con las guardias activas.');
  } else {
    console.log('\n   ❌ HAY LEAKS — Algún módulo está bypasseando las guardias');
    console.log('   NO hagas push hasta resolver esto.');
  }

  console.log('');

  // Restore fetch
  globalThis.fetch = originalFetch;
}

runTest().catch(err => {
  console.error('Error corriendo test:', err);
  process.exit(1);
});
