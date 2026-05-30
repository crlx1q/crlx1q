const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const bin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tailwindcss.cmd' : 'tailwindcss');
const out = path.join(__dirname, '..', 'public', 'assets', 'tailwind.css');

if (fs.existsSync(bin)) {
  const result = spawnSync(bin, [
    '-c', 'tailwind.config.js',
    '-i', './src/tailwind.css',
    '-o', './public/assets/tailwind.css',
    '--minify'
  ], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  process.exit(result.status || 0);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '/* Tailwind CLI is not installed in this environment. Optional: run npm install --save-dev tailwindcss@3.4.17, then npm run build:css to generate this file. */\n');
console.warn('[tailwind] CLI not found; wrote placeholder public/assets/tailwind.css. Optional local setup: npm install --save-dev tailwindcss@3.4.17');
