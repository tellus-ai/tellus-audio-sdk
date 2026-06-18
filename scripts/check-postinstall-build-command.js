#!/usr/bin/env node
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const distCli = path.join(distDir, 'installer', 'install-binary-cli.js');
const srcCli = path.join(root, 'src', 'installer', 'install-binary-cli.ts');

function runBuild() {
  const npmExec = process.env.npm_execpath;
  if (npmExec) {
    cp.execFileSync(process.execPath, [npmExec, 'run', 'build'], { cwd: root, stdio: 'inherit' });
    return;
  }

  if (process.platform === 'win32') {
    cp.execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm run build'], {
      cwd: root,
      stdio: 'inherit',
    });
    return;
  }

  cp.execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
}

fs.rmSync(distDir, { recursive: true, force: true });

if (!fs.existsSync(srcCli)) {
  throw new Error(`source installer CLI is missing: ${path.relative(root, srcCli)}`);
}

runBuild();

if (!fs.existsSync(distCli)) {
  throw new Error(`build did not create ${path.relative(root, distCli)}`);
}

console.log('Postinstall build command verified; native binary install was not run.');
