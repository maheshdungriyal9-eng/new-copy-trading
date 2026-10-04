const fs = require('fs');
const content = fs.readFileSync('frontend/index.html', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('account-list') || line.includes('accounts-list') || line.includes('accounts-container') || line.includes('account-card')) {
    if (line.length < 150) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
