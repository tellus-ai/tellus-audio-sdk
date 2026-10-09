'use strict';

// Expo가 생성하는 OS 설정만 수정한다. 녹음과 승인은 SDK의 기존 공개 API가 소유한다.
module.exports = function withTellusAudio(config, options = {}) {
  const projectRoot = config._internal?.projectRoot ?? process.cwd();
  const plugins = require(require.resolve('expo/config-plugins', { paths: [projectRoot] }));
  const { withInfoPlist, withAndroidManifest, withGradleProperties } = plugins;
  config = withInfoPlist(config, value => {
    value.modResults.NSMicrophoneUsageDescription = options.microphonePermission ??
      value.modResults.NSMicrophoneUsageDescription ?? '실시간 음성 처리를 위해 마이크를 사용합니다.';
    if (options.backgroundAudio === true) {
      value.modResults.UIBackgroundModes = [...new Set([...(value.modResults.UIBackgroundModes ?? []), 'audio'])];
    }
    return value;
  });
  config = withAndroidManifest(config, value => {
    const permissions = value.modResults.manifest['uses-permission'] ??= [];
    for (const name of ['android.permission.RECORD_AUDIO', 'android.permission.POST_NOTIFICATIONS']) {
      if (!permissions.some(permission => permission.$?.['android:name'] === name)) permissions.push({ $: { 'android:name': name } });
    }
    return value;
  });
  return withGradleProperties(config, value => {
    const properties = value.modResults;
    const architecture = properties.find(property => property.type === 'property' && property.key === 'reactNativeArchitectures');
    const supported = ['arm64-v8a', 'x86_64'];
    const requested = architecture?.value.split(',').map(value => value.trim()) ?? supported;
    const selected = supported.filter(value => requested.includes(value));
    if (!selected.length) throw new Error('Tellus Audio SDK requires arm64-v8a or x86_64');
    if (architecture) architecture.value = selected.join(',');
    else properties.push({ type: 'property', key: 'reactNativeArchitectures', value: selected.join(',') });
    return value;
  });
};
