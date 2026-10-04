const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'services', 'motilalService.js');
if (fs.existsSync(filePath)) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  console.log('--- Matches for product type in motilalService.js ---');
  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    if (line.toLowerCase().includes('product') || line.toLowerCase().includes('margin')) {
      console.log(`${lineNum}: ${line.trim()}`);
    }
  });
} else {
  console.log('Motilal service file not found.');
}
