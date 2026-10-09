import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(__dirname, '..', '..');

// 기존 앱 파일을 보존하면서 설치된 엔진과 SDK의 상대 ESM 경로를 복사한다.
export function copyWebAssets(destination: string): void {
  const source = join(ROOT, 'vendor', 'web');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'release-assets.json'), 'utf8')) as {
    assets: { web: { requiredFiles: string[] } };
  };
  const browser = join(ROOT, 'dist-browser');
  const ort = dirname(require.resolve('onnxruntime-web'));
  const ortNotices = join(ROOT, 'licenses', 'onnxruntime-web');
  const runtimeFiles = ['ort.wasm.bundle.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
  const required = [
    ...manifest.assets.web.requiredFiles.map((file) => join(source, file)),
    join(browser, 'browser', 'worker.js'), join(browser, 'browser', 'worklet.js'),
    ...runtimeFiles.map((file) => join(ort, file)),
    ...['LICENSE', 'ThirdPartyNotices.txt'].map((file) => join(ortNotices, file)),
  ];
  const missing = required.filter((file) => !existsSync(file) || !statSync(file).isFile());
  if (missing.length > 0) throw new Error(`Web assets are missing required files: ${missing.join(', ')}`);

  const output = resolve(destination);
  mkdirSync(output, { recursive: true });
  for (const file of manifest.assets.web.requiredFiles) {
    mkdirSync(dirname(join(output, file)), { recursive: true });
    cpSync(join(source, file), join(output, file));
  }
  for (const file of ['licenses', 'build-manifest.json']) {
    if (existsSync(join(source, file))) cpSync(join(source, file), join(output, file), { recursive: true });
  }
  cpSync(browser, output, { recursive: true });
  cpSync(ortNotices, join(output, 'licenses', 'onnxruntime-web'), { recursive: true });
  mkdirSync(join(output, 'ort'), { recursive: true });
  for (const file of runtimeFiles) cpSync(join(ort, file), join(output, 'ort', file));
  console.log(`[tellus-audio-sdk] Web assets copied to ${output}`);
}
