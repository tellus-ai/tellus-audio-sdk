const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const runtimeSource = fs.readFileSync(path.resolve(__dirname,
  '../platforms/desktop/runtime/platforms/desktop/electron/runtime/engine-runtime.js'), 'utf8');

function fixture({ platform = 'win32', env = {}, packageRoot, assetRoot, nativeName, missingNative = false } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const assetKey = { win32: 'win32-x64-msvc', darwin: 'darwin-arm64', linux: 'linux-x64-gnu' }[platform];
  const vendorKey = platform === 'darwin' ? 'darwin-universal' : assetKey;
  const ortKey = { win32: 'win32-x64', darwin: 'darwin-universal', linux: 'linux-x64' }[platform];
  const ortName = { win32: 'onnxruntime.dll', darwin: 'libonnxruntime.dylib', linux: 'libonnxruntime.so' }[platform];
  const defaultNativeName = `audio-capture.${vendorKey}.node`;
  packageRoot ||= platform === 'win32' ? 'C:\\Program Files\\Tellus\\audio-sdk' : '/opt/tellus/audio-sdk';
  assetRoot ||= paths.join(packageRoot, 'vendor', vendorKey);
  const nativePath = paths.join(assetRoot, nativeName || defaultNativeName);
  const ortPath = paths.join(assetRoot, 'onnxruntime', ortKey, ortName);
  const modelDir = paths.join(assetRoot, 'models');
  const files = new Set([ortPath, modelDir, ...(missingNative ? [] : [nativePath])]);
  const processMock = { platform, env: { ...env } };
  const nativeBinding = { loaded: true };
  const loads = [];
  const exports = {};
  vm.runInNewContext(runtimeSource, {
    exports,
    __dirname: paths.join(packageRoot, 'runtime', 'platforms', 'desktop', 'electron', 'runtime'),
    process: processMock,
    require(specifier) {
      if (specifier === 'node:path') return paths;
      if (specifier === 'node:fs') return {
        existsSync: candidate => files.has(candidate),
        readdirSync: () => [],
      };
      if (specifier.endsWith('/asset-key.js')) return {
        currentAssetKey: () => assetKey,
        nativeFileCandidates: () => [defaultNativeName],
        ortRuntimeKeys: () => [ortKey, assetKey],
      };
      assert.equal(specifier, nativePath);
      // Capture the environment at require time: setting it afterwards cannot fix DLL loading.
      loads.push({ path: specifier, env: { ...processMock.env } });
      return nativeBinding;
    },
  }, { filename: 'engine-runtime.js' });
  return { runtime: exports, loads, nativeBinding, nativePath, ortPath, modelDir, assetRoot, paths };
}

for (const pathKey of ['Path', 'PATH', 'path']) {
  test(`Windows prepares bundled DLLs before native loading and preserves ${pathKey}`, () => {
    const nativeDir = 'C:\\Program Files\\Tellus\\audio-sdk\\vendor\\win32-x64-msvc';
    const otherPaths = ['C:\\Windows\\System32', 'C:\\Tools'];
    const currentPath = [otherPaths[0], nativeDir.toUpperCase() + '\\', otherPaths[1]].join(';');
    const f = fixture({ env: { [pathKey]: currentPath } });
    assert.equal(f.runtime.prepareEngineRuntime().nativeBinding, f.nativeBinding);
    f.runtime.prepareEngineRuntime();
    assert.equal(f.loads.length, 2);
    for (const load of f.loads) {
      assert.equal(load.env[pathKey], [nativeDir, ...otherPaths].join(';'));
      assert.deepEqual(Object.keys(load.env).filter(key => key.toLowerCase() === 'path'), [pathKey]);
      assert.equal(load.env.ORT_DYLIB_PATH, f.ortPath);
      assert.equal(load.env.TELLUS_AUDIO_ENGINE_MODEL_DIR, f.modelDir);
    }
  });
}

test('Windows honors explicit ORT and model paths and initializes a missing PATH', () => {
  const f = fixture({ env: {
    ORT_DYLIB_PATH: 'D:/custom/runtime/../onnxruntime.dll',
    TELLUS_AUDIO_ENGINE_MODEL_DIR: 'D:/custom/models/../encrypted-models',
  } });
  f.runtime.prepareEngineRuntime();
  const { env } = f.loads[0];
  assert.equal(env.ORT_DYLIB_PATH, 'D:\\custom\\onnxruntime.dll');
  assert.equal(env.TELLUS_AUDIO_ENGINE_MODEL_DIR, 'D:\\custom\\encrypted-models');
  assert.equal(env.Path, f.assetRoot);
});

test('packaged Electron loads the unpacked addon and prepares its DLL directory', () => {
  const packageRoot = 'C:\\Tellus\\resources\\app.asar\\node_modules\\@tellus-ai\\audio-sdk-desktop';
  const assetRoot = path.win32.join(packageRoot.replace('app.asar', 'app.asar.unpacked'), 'vendor', 'win32-x64-msvc');
  const f = fixture({ packageRoot, assetRoot, env: { Path: 'C:\\Windows\\System32' } });
  f.runtime.prepareEngineRuntime();
  assert.equal(f.loads[0].path, path.win32.join(assetRoot, 'audio-capture.win32-x64-msvc.node'));
  assert.equal(f.loads[0].env.Path, `${assetRoot};C:\\Windows\\System32`);
  assert.equal(f.loads[0].env.ORT_DYLIB_PATH, f.ortPath);
});

for (const platform of ['darwin', 'linux']) {
  test(`${platform} keeps PATH unchanged while resolving native assets`, () => {
    const f = fixture({ platform, env: { PATH: '/usr/bin:/bin' } });
    f.runtime.prepareEngineRuntime();
    assert.equal(f.loads[0].env.PATH, '/usr/bin:/bin');
    assert.equal(f.loads[0].env.ORT_DYLIB_PATH, f.ortPath);
    assert.equal(f.loads[0].env.TELLUS_AUDIO_ENGINE_MODEL_DIR, f.modelDir);
  });
}

test('development runtime can load an architecture-specific macOS addon from the repository root', () => {
  const f = fixture({ platform: 'darwin', packageRoot: '/engine/dist', assetRoot: '/engine',
    nativeName: 'audio-capture.darwin-arm64.node' });
  f.runtime.prepareEngineRuntime();
  assert.equal(f.loads[0].path, '/engine/audio-capture.darwin-arm64.node');
});

test('missing native addon fails before attempting to load a module', () => {
  const f = fixture({ missingNative: true });
  assert.throws(() => f.runtime.prepareEngineRuntime(), /Failed to find Tellus audio engine native binary/);
  assert.equal(f.loads.length, 0);
});
