const fs = require('fs');
const path = require('path');

const walk = (dir) => {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      if (!file.includes('node_modules') && !file.includes('.git')) {
        results = results.concat(walk(file));
      }
    } else {
      if (file.endsWith('.js')) results.push(file);
    }
  });
  return results;
};

const jsFiles = walk('.');
console.log(`Searching toLowerCase in ${jsFiles.length} files...`);
jsFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('toLowerCase')) {
      console.log(`${file} : Line ${idx + 1} : ${line.trim()}`);
    }
  });
});
