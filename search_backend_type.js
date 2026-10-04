const fs = require('fs');
const path = require('path');

function searchDir(dir) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules') searchDir(fullPath);
    } else if (file.endsWith('.js')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (line.includes("type === 'master'") || line.includes('type === "master"') || line.includes(".type === 'child'") || line.includes('.type === "child"')) {
          console.log(`${file}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
  });
}

searchDir('backend');
