const fs = require('fs');
const path = require('path');

function searchDir(dir) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules') {
        searchDir(filePath);
      }
    } else if (file.endsWith('.js')) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (line.includes('ssh2') || line.includes('tunnelService')) {
          console.log(`${filePath}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
  });
}

searchDir(path.join(__dirname, 'backend'));
