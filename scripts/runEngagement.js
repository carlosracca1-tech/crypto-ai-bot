'use strict';

/**
 * Script manual para ejecutar el módulo de engagement.
 *
 * Uso:
 *   npm run engagement          → modo live
 *   npm run engagement:dry      → dry run (no postea)
 *   DRY_RUN=true node scripts/runEngagement.js
 */

require('dotenv').config();
const { runEngagement } = require('../src/engagement/engagementManager');

async function main() {
  try {
    const result = await runEngagement();
    console.log('\nResultado:', JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Error fatal en engagement:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
