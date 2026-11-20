// Optional native packaging check. Use GRADLE for the Gradle executable, or RUBY with the CocoaPods gems.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platform = process.argv[2];
if (!['ios', 'android'].includes(platform)) throw new Error('Usage: node scripts/test-mobile-speech-resources.mjs ios|android');
const scripts = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(scripts, '../platforms/mobile');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-model-resources-'));
const vendor = path.join(fixture, 'vendor', platform);
const resources = ['models/denoise.temc', 'models/vad.temc', 'models/extra.temc',
  'speech-detection/silero_vad_v6.2.onnx', 'licenses/silero-vad.txt'];
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

try {
  for (const file of [...resources, 'models/plaintext.onnx', 'speech-detection/other.onnx', 'licenses/other.txt']) {
    const destination = path.join(vendor, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file);
  }
  let output;
  if (platform === 'ios') {
    for (const file of ['TellusAudioSdk.podspec', 'package.json', 'nitrogen']) {
      fs.cpSync(path.join(mobile, file), path.join(fixture, file), { recursive: true });
    }
    run(process.env.RUBY ?? 'ruby', [path.join(scripts, 'fixtures/mobile-resource-bundle.rb')], fixture);
    run('xcodebuild', ['-project', 'Resources.xcodeproj', '-target', 'TellusAudioSdkModels', '-sdk', 'iphonesimulator',
      'CODE_SIGNING_ALLOWED=NO', `CONFIGURATION_BUILD_DIR=${fixture}/products`, 'build'], fixture);
    output = path.join(fixture, 'products/TellusAudioSdkModels.bundle');
  } else {
    const project = path.join(fixture, 'android');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'settings.gradle'), "rootProject.name = 'resource-test'\n");
    fs.copyFileSync(path.join(mobile, 'android/model-assets.gradle'), path.join(project, 'build.gradle'));
    run(process.env.GRADLE ?? 'gradle', ['--offline', 'syncTellusModelAssets'], project);
    output = path.join(project, 'build/generated/tellus-model-assets/tellus-audio-sdk');
  }
  const actual = fs.readdirSync(output).filter(name => name !== 'Info.plist');
  assert.deepEqual(actual.sort(), resources.map(file => path.posix.basename(file)).sort());
  for (const resource of resources) {
    assert.equal(fs.readFileSync(path.join(output, path.posix.basename(resource)), 'utf8'), resource);
  }
  console.log(`Verified ${platform} final resources including flattened Silero, notice and all TEMC files.`);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
