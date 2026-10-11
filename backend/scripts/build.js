const esbuild = require('esbuild');
const path = require('path');
for (const [source, output] of [['app_v6.js', 'app_v6.min.js'], ['style.css', 'style.min.css']]) {
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '../../frontend', source)], outfile: path.join(__dirname, '../../frontend', output), minify: true });
}
