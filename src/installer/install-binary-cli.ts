import { installBinary } from './install-binary';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function fail(message: string): never {
  console.error(`[tellus-audio-sdk] ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let platform: string | undefined;
let output: string | undefined;
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!value || (flag !== '--platform' && flag !== '--out')) {
    fail('Usage: install-binary-cli [--platform ios|android|web] [--out <web-static-directory>]');
  }
  if (flag === '--platform') {
    if (platform !== undefined) fail('--platform must be specified once');
    platform = value;
  } else {
    if (output !== undefined) fail('--out must be specified once');
    output = value;
  }
}
const packagePlatform = (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { tellusPlatform?: string }).tellusPlatform;
const selectedPlatform = platform ?? process.env.TELLUS_AUDIO_ENGINE_PLATFORM;
const targets = selectedPlatform !== undefined ? [selectedPlatform] :
  packagePlatform === 'web' ? ['web'] : packagePlatform === 'mobile' ?
    ['ios', 'android'] : [undefined];
if (packagePlatform === 'mobile' && targets.some(target => target !== 'ios' && target !== 'android')) {
  fail('Mobile installation requires the ios or android target');
}
if (output !== undefined && (targets.length !== 1 || targets[0] !== 'web')) {
  fail('--out requires the web installation platform');
}

(async () => {
  for (const target of targets) await installBinary(target);
  if (output !== undefined) require('./copy-web-assets').copyWebAssets(output);
})().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
