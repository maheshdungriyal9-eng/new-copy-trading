const fs = require('fs');
const content = fs.readFileSync('frontend/app.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('selectedAccId') || line.includes('selectedAcc') || line.includes('order-account-select')) {
    if (line.length < 150) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
