const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const files = [
  'backend/services/orderQueueService.js',
  'backend/services/dhanTradeService.js',
  'backend/services/dhanService.js',
  'backend/services/angelOneService.js',
  'backend/services/motilalService.js',
  'backend/services/instrumentService.js',
  'backend/services/copyTradingEngine.js'
];

let failed = false;
files.forEach(file => {
  const filepath = path.join(__dirname, '..', file);
  try {
    execSync(`node -c "${filepath}"`);
    console.log(`[PASS] Syntax check passed for: ${file}`);
  } catch (err) {
    console.error(`[FAIL] Syntax error in: ${file}`);
    console.error(err.stdout.toString() || err.stderr.toString() || err.message);
    failed = true;
  }
});

if (failed) {
  process.exit(1);
} else {
  console.log('All files passed syntax check!');
}
