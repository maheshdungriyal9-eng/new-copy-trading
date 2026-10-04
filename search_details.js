const fs = require('fs');
const content = fs.readFileSync('frontend/app_v6.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, index) => {
  if (line.toLowerCase().includes('stock-details') || line.includes('openStockDetails') || line.includes('showStockDetails')) {
    if (line.includes('function') || line.includes('click') || line.includes('addEventListener') || line.includes('document.getElementById')) {
      console.log(`${index + 1}: ${line.trim()}`);
    }
  }
});
