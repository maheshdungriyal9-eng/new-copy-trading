const fs = require('fs');
const vm = require('vm');
const path = require('path');

try {
    const code = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app_v6.js'), 'utf8');
    new vm.Script(code);
    console.log('Syntax check passed: app_v6.js is syntactically correct.');
} catch (e) {
    console.error('Syntax error found in app_v6.js:', e);
}
