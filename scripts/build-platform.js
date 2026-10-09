const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');

// 두 플랫폼의 빌드 결과는 Node와 독립된 ESM 경계를 가진다.
const platform = process.argv[2];
const targets = {
  browser: ['tsconfig.browser.json', 'dist-browser'],
  native: ['tsconfig.react-native.json', 'dist-native'],
};
const target = targets[platform];
if (!target) throw new Error('Expected browser or native');
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', target[0]], { stdio: 'inherit' });
writeFileSync(target[1] + '/package.json', '{"type":"module"}\n');
