const fs = require('fs');
const path = require('path');

const jsPath = path.join(__dirname, '..', 'frontend', 'app_v6.js');
const content = fs.readFileSync(jsPath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for renderWatchlistTable in app_v6.js ---');
let startLine = -1;
lines.forEach((line, index) => {
    if (line.includes('function renderWatchlistTable')) {
        startLine = index + 1;
    }
});
if (startLine !== -1) {
    for (let i = startLine; i <= startLine + 120; i++) {
        console.log(`${i}: ${lines[i-1]}`);
    }
}
