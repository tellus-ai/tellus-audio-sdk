import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// POSIX host with C++20, SDK npm dependencies, hydrated v0.4.10 engine sources and their
// test-license C ABI library. Set ORT_DYLIB_PATH to the matching host ONNX Runtime library.
// Only the OS device, resource read and platform threading hooks are doubled.
const [enginePath, libraryPath] = process.argv.slice(2);
if (!enginePath || !libraryPath) {
  throw new Error('Usage: node scripts/test-mobile-speech-native.mjs V0.4.10_ENGINE_SOURCE HOST_LIBRARY_DIRECTORY');
}
if (process.env.TELLUS_ENGINE_TEST_LICENSE !== '1') throw new Error('Test-only license opt-in required');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineRoot = resolve(enginePath);
const libraryDirectory = resolve(libraryPath);
const tests = resolve(engineRoot, 'src/platforms/mobile/cpp/tests');
const mobileRoot = resolve(root, 'platforms/mobile');
const jsiDirectory = resolve(root, 'node_modules/react-native/ReactCommon/jsi');
const nitro = resolve(root, 'node_modules/react-native-nitro-modules/cpp');
const spec = resolve(mobileRoot, 'nitrogen/generated/shared/c++');
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

function run(command, args, environment = {}, timeout) {
  const result = spawnSync(command, args, {
    stdio: 'inherit', env: { ...process.env, TMPDIR: temporary, ...environment }, timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.signal}`);
}

// 두 경계 테스트가 같은 Nitro·JSI 소스와 호스트 Rust 라이브러리를 링크한다.
function build(name, sources) {
  const executable = resolve(temporary, name);
  const linkerFlags = process.platform === 'darwin' ? ['-Wl,-dead_strip'] : ['-Wl,--gc-sections'];
  run(process.env.CXX ?? 'c++', [
    '-std=c++20', '-O0', '-ffunction-sections', '-fdata-sections',
    '-I', temporary, '-I', headers, '-I', jsiDirectory, '-I', tests,
    '-I', resolve(engineRoot, 'src/bindings/c/include'), '-I', resolve(mobileRoot, 'cpp'), '-I', spec,
    ...sources, resolve(mobileRoot, 'cpp/CaptureWorker.cpp'), resolve(mobileRoot, 'cpp/MicrophonePriority.cpp'),
    resolve(nitro, 'core/Promise.cpp'), resolve(nitro, 'core/ArrayBuffer.cpp'),
    resolve(nitro, 'core/HybridObject.cpp'), resolve(nitro, 'prototype/HybridObjectPrototype.cpp'),
    resolve(nitro, 'jsi/JSICache.cpp'), resolve(nitro, 'threading/Dispatcher.cpp'),
    resolve(nitro, 'threading/ThreadPool.cpp'), resolve(nitro, 'utils/CommonGlobals.cpp'),
    resolve(nitro, 'utils/PropNameIDCache.cpp'),
    resolve(nitro, 'utils/NitroTypeInfo.cpp'), resolve(jsiDirectory, 'jsi/jsi.cpp'),
    '-L', libraryDirectory, '-ltellus_audio_engine', `-Wl,-rpath,${libraryDirectory}`,
    ...linkerFlags, '-o', executable,
  ]);
  return executable;
}

try {
  linkHeaders(nitro);
  const executable = build('capture-session-test', [
    resolve(tests, 'capture-session.test.cpp'), resolve(tests, 'microphone-handoff.test.cpp'),
    resolve(mobileRoot, 'cpp/CaptureSession.cpp'),
    resolve(mobileRoot, 'cpp/HybridTellusCapture.cpp'), resolve(mobileRoot, 'cpp/DenoiseSettings.cpp'),
    resolve(mobileRoot, 'cpp/InputHold.cpp'), resolve(mobileRoot, 'cpp/LastError.cpp'),
    resolve(spec, 'HybridTellusCaptureSpec.cpp'),
    resolve(mobileRoot, 'cpp/HybridTellusSpeechDetector.cpp'), resolve(spec, 'HybridTellusSpeechDetectorSpec.cpp'),
  ]);
  // 발화 감지기는 capture 소스 없이 감지기 C ABI만 링크해 실제 평문 Silero로 돌린다.
  const detector = build('speech-detector-test', [
    resolve(root, 'scripts/fixtures/mobile-speech-detector.cpp'), resolve(mobileRoot, 'cpp/HybridTellusSpeechDetector.cpp'),
    resolve(spec, 'HybridTellusSpeechDetectorSpec.cpp'),
  ]);
  // macOS dylib의 빌드 디렉터리 install_name도 보존한 호스트 라이브러리로 해석한다.
  const environment = process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: libraryDirectory } : {};
  run(detector, [resolve(engineRoot, 'models/silero_vad_v6.2.onnx')], environment, 120000);
  run(executable, [engineRoot, resolve(tests, 'platform-fixture.cjs')], environment, 120000);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
