'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const withTellusAudio = require('../platforms/mobile/app.plugin');

// 소비 앱의 Expo re-export 경계만 구성하며 Mods는 실제 SDK 개발 의존성을 사용한다.
const host = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-expo-plugin-'));
const expo = path.join(host, 'node_modules/expo');
fs.mkdirSync(expo, { recursive: true });
fs.writeFileSync(path.join(expo, 'config-plugins.js'), `module.exports = require(${JSON.stringify(require.resolve('@expo/config-plugins'))});`);
after(() => fs.rmSync(host, { recursive: true, force: true }));

async function apply(platform, name, input, options) {
  const config = withTellusAudio({ name: 'test', slug: 'test', _internal: { projectRoot: host } }, options);
  return (await config.mods[platform][name]({ ...config, modResults: structuredClone(input),
    modRequest: { projectRoot: process.cwd(), platform, modName: name } })).modResults;
}

test('마이크 문구와 다른 background 설정을 보존하고 audio는 명시한 경우에만 추가한다', async () => {
  const current = { NSMicrophoneUsageDescription: '기존 안내', UIBackgroundModes: ['fetch'] };
  assert.deepEqual(await apply('ios', 'infoPlist', current), current);
  const enabled = await apply('ios', 'infoPlist', current, { backgroundAudio: true, microphonePermission: '새 안내' });
  assert.deepEqual(enabled, { NSMicrophoneUsageDescription: '새 안내', UIBackgroundModes: ['fetch', 'audio'] });
  assert.deepEqual(await apply('ios', 'infoPlist', enabled, { backgroundAudio: true }), enabled);
  assert.equal(typeof (await apply('ios', 'infoPlist', {})).NSMicrophoneUsageDescription, 'string');
});

test('Android 기존 권한을 보존하며 마이크 권한을 중복 생성하지 않는다', async () => {
  const existing = { manifest: { 'uses-permission': [{ $: { 'android:name': 'android.permission.INTERNET' } }] } };
  const added = await apply('android', 'manifest', existing);
  assert.equal(added.manifest['uses-permission'].length, 3);
  assert.deepEqual(await apply('android', 'manifest', added), added);
});

test('지원 ABI만 생성하고 앱이 선택한 부분집합과 다른 Gradle 속성을 유지한다', async () => {
  const other = { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx2g' };
  const architecture = value => ({ type: 'property', key: 'reactNativeArchitectures', value });
  for (const requested of ['armeabi-v7a,arm64-v8a,x86,x86_64', 'arm64-v8a', 'x86_64']) {
    const actual = await apply('android', 'gradleProperties', [other, architecture(requested)]);
    assert.deepEqual(actual[0], other);
    assert.equal(actual[1].value, requested.split(',').filter(value => ['arm64-v8a', 'x86_64'].includes(value)).join(','));
    assert.deepEqual(await apply('android', 'gradleProperties', actual), actual);
  }
  assert.deepEqual(await apply('android', 'gradleProperties', []), [architecture('arm64-v8a,x86_64')]);
  await assert.rejects(apply('android', 'gradleProperties', [architecture('armeabi-v7a')]), /requires arm64-v8a or x86_64/);
});
