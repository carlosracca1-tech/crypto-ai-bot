'use strict';
require('dotenv').config();
const { runDailyHealthCheck } = require('../src/alerts/healthCheck');

async function main() {
  try {
    const result = await runDailyHealthCheck();
    console.log('\nHealth Check Result:', JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
main();
