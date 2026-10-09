import { installBinary } from './install-binary';
import { copyWebAssets } from './copy-web-assets';

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
if (output !== undefined && (platform ?? process.env.TELLUS_AUDIO_ENGINE_PLATFORM) !== 'web') {
  fail('--out requires the web installation platform');
}

installBinary(platform).then(() => {
  if (output !== undefined) copyWebAssets(output);
}).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
