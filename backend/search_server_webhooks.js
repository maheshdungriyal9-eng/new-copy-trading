const fs = require('fs');
const code = fs.readFileSync('server.js', 'utf8');
const lines = code.split('\n');
console.log('Searching in server.js for rebuildGlobalMappings...');
lines.forEach((line, idx) => {
  if (line.includes('rebuildGlobalMappings')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
