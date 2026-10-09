const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) check(filename);
    else if (entry.name.endsWith('.js')) execFileSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
  }
}
for (const platform of ['desktop', 'web', 'mobile']) {
  check(path.join(root, 'platforms', platform, 'runtime'));
  check(path.join(root, 'platforms', platform, 'dist'));
}
