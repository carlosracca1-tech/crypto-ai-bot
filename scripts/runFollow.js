'use strict';
require('dotenv').config();
const { runFollowEngine } = require('../src/growth/followEngine');

async function main() {
  try {
    const result = await runFollowEngine();
    console.log('\nResultado:', JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
main();
