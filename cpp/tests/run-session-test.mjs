import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// OS 장치만 double로 바꾸고 Rust·Nitro·JSI는 실제 구현을 링크한다.
const [engineRoot, libraryDirectory, jsiDirectory] = process.argv.slice(2);
if (!engineRoot || !libraryDirectory || !jsiDirectory) {
  throw new Error('Usage: node cpp/tests/run-session-test.mjs ENGINE_ROOT HOST_LIBRARY_DIRECTORY RN_JSI_DIRECTORY');
}
if (process.env.TELLUS_ENGINE_TEST_LICENSE !== '1') throw new Error('Test-only license opt-in required');
const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nitro = resolve(sdk, 'node_modules/react-native-nitro-modules/cpp');
const temporary = mkdtempSync('/tmp/tellus-session-build-');
const headers = resolve(temporary, 'NitroModules');
mkdirSync(headers);

function linkHeaders(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) linkHeaders(path);
    else if (entry.name.endsWith('.hpp')) symlinkSync(path, resolve(headers, entry.name));
  }
}

function run(command, args, environment = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit', env: { ...process.env, TMPDIR: temporary, ...environment }, timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.signal}`);
}

try {
  linkHeaders(nitro);
  const executable = resolve(temporary, 'capture-session-test');
  const linkerFlags = process.platform === 'darwin' ? ['-Wl,-dead_strip'] : ['-Wl,--gc-sections'];
  run(process.env.CXX ?? 'c++', [
    '-std=c++20', '-O0', '-ffunction-sections', '-fdata-sections',
    '-I', temporary, '-I', headers, '-I', jsiDirectory,
    '-I', resolve(engineRoot, 'include'), '-I', resolve(sdk, 'cpp'),
    resolve(sdk, 'cpp/tests/capture-session.test.cpp'),
    resolve(sdk, 'cpp/CaptureSession.cpp'), resolve(sdk, 'cpp/CaptureWorker.cpp'),
    resolve(nitro, 'core/Promise.cpp'), resolve(nitro, 'core/ArrayBuffer.cpp'),
    resolve(nitro, 'utils/NitroTypeInfo.cpp'), resolve(jsiDirectory, 'jsi/jsi.cpp'),
    '-L', libraryDirectory, '-ltellus_audio_engine', `-Wl,-rpath,${libraryDirectory}`,
    ...linkerFlags, '-o', executable,
  ]);
  // macOS dylib의 빌드 디렉터리 install_name도 보존한 호스트 라이브러리로 해석한다.
  const environment = process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: libraryDirectory } : {};
  run(executable, [engineRoot, resolve(sdk, 'cpp/tests/platform-fixture.cjs')], environment);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
