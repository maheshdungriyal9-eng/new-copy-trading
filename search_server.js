const fs = require('fs');
const content = fs.readFileSync('dhan_api_v2_documentation.md', 'utf8');
content.split('\n').forEach((line, idx) => {
  if (line.toLowerCase().includes('/profile') || line.toLowerCase().includes('client') || line.toLowerCase().includes('name')) {
    if (line.trim().startsWith('|') || line.trim().startsWith('-') || line.includes('api.dhan.co')) {
      console.log(`${idx + 1}: ${line.trim().substring(0, 120)}`);
    }
  }
});
