const fs = require('fs');
const content = fs.readFileSync('frontend/app.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('btn-submit-order') || line.includes('submit-order') || line.includes('order-form') || line.includes('submit', 50)) {
    if (line.length < 150) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
