#!/usr/bin/env node

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(path.resolve(__dirname, '..'));

function resolveBeforeCreate(requestedPath) {
  let unresolvedPath = path.resolve(requestedPath);
  const suffix = [];

  while (!fs.existsSync(unresolvedPath)) {
    const parentPath = path.dirname(unresolvedPath);
    if (parentPath === unresolvedPath) {
      throw new Error(`[BuildStorage] Cannot resolve cache root: ${requestedPath}`);
    }

    suffix.unshift(path.basename(unresolvedPath));
    unresolvedPath = parentPath;
  }

  return path.join(fs.realpathSync(unresolvedPath), ...suffix);
}

function isInside(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

const [requestedCommand, ...args] = process.argv.slice(2);
if (!requestedCommand) {
  console.error('[BuildStorage] A command is required.');
  process.exit(1);
}

const requestedCacheRoot =
  process.env.TELLUS_BUILD_CACHE_ROOT || path.join(root, '.build-cache');
let cacheRoot = resolveBeforeCreate(requestedCacheRoot);

if (
  process.platform !== 'win32' &&
  (cacheRoot === '/tmp' ||
    cacheRoot.startsWith('/tmp/') ||
    cacheRoot === '/private/tmp' ||
    cacheRoot.startsWith('/private/tmp/'))
) {
  console.error(`[BuildStorage] Refusing to use a temporary directory: ${cacheRoot}`);
  process.exit(1);
}

if (!isInside(root, cacheRoot)) {
  console.error(`[BuildStorage] Cache root must stay inside the repository: ${cacheRoot}`);
  process.exit(1);
}

fs.mkdirSync(cacheRoot, { recursive: true });
cacheRoot = fs.realpathSync(cacheRoot);

const storagePaths = {
  TMPDIR: path.join(cacheRoot, 'tmp'),
  GRADLE_USER_HOME: path.join(cacheRoot, 'gradle'),
  YARN_GLOBAL_FOLDER: path.join(cacheRoot, 'yarn', 'global'),
  YARN_CACHE_FOLDER: path.join(cacheRoot, 'yarn', 'cache'),
  TELLUS_IOS_DERIVED_DATA_PATH: path.join(cacheRoot, 'xcode', 'DerivedData'),
  npm_config_cache: path.join(cacheRoot, 'npm'),
  UV_CACHE_DIR: path.join(cacheRoot, 'uv'),
  PIP_CACHE_DIR: path.join(cacheRoot, 'pip'),
  CARGO_TARGET_DIR: path.join(cacheRoot, 'cargo', 'target'),
  ELECTRON_CACHE: path.join(cacheRoot, 'electron'),
  ELECTRON_BUILDER_CACHE: path.join(cacheRoot, 'electron-builder'),
  XDG_CACHE_HOME: path.join(cacheRoot, 'xdg'),
};

for (const storagePath of Object.values(storagePaths)) {
  fs.mkdirSync(storagePath, { recursive: true });
}

const env = {
  ...process.env,
  ...storagePaths,
  TELLUS_BUILD_CACHE_ROOT: cacheRoot,
  TELLUS_BUILD_STORAGE_CONFIGURED: '1',
  YARN_ENABLE_GLOBAL_CACHE: 'false',
};
const command = requestedCommand === 'node' ? process.execPath : requestedCommand;
const result = cp.spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
