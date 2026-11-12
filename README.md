# Tellus Audio SDK

이 저장소는 플랫폼별 SDK 실행 래퍼·설치·패키징·고객 프로젝트 자동 설정을 담당합니다. 실행 래퍼 원본은 `src`에, 모바일 네이티브 연결 코드는 `platforms/mobile`에 있습니다.

| 대상 | 설치 패키지 | 문서 |
| --- | --- | --- |
| Electron | `@tellus-ai/audio-sdk-desktop` | [Desktop](platforms/desktop/README.md) |
| 브라우저 | `@tellus-ai/audio-sdk-web` | [Web](platforms/web/README.md) |
| React Native·Expo 개발 앱 | `@tellus-ai/audio-sdk-mobile` | [Mobile](platforms/mobile/README.md) |

각 플랫폼의 `package.json`은 자신의 실행 파일과 의존성만 배포합니다. 기존 단일 패키지의 `/browser`·`/react-native` 진입점은 각 플랫폼 패키지의 기본 진입점으로 이동했습니다. 승인 API는 모든 패키지의 `/authorization`으로 제공합니다. Expo plugin 이름은 `@tellus-ai/audio-sdk-mobile`입니다.

## 설치

고객에게 발급한 `TELLUS_AUDIO_ENGINE_TOKEN`과 HTTPS 서비스 `TELLUS_AUDIO_DOWNLOAD_BASE_URL`을 설정한 뒤 대상 패키지를 설치합니다. 설치된 패키지만 엔진 산출물을 다운로드하고 SHA-256을 검증합니다. 설치 과정은 엔진 저장소나 Rust·TypeScript 소스 빌드를 요구하지 않습니다. root workspace에는 postinstall이 없습니다.

Desktop은 OS·CPU에 맞는 엔진을 선택합니다. Web은 웹 엔진만 설치합니다. Mobile은 iOS·Android를 설치하며 `TELLUS_AUDIO_ENGINE_PLATFORM=ios` 또는 `android`로 대상을 제한할 수 있습니다. SDK `0.3.4`의 엔진 버전은 `0.4.4`입니다. 정확한 엔진 버전은 `release-assets.json`에 고정되어 있습니다. 실행 승인 토큰과 모델 키는 설치 토큰과 별개이며 앱의 서버 연결에서 전달합니다.

## 유지보수 빌드

SDK 저장소의 실행 래퍼와 설치 코드를 빌드하고 세 플랫폼 패키지를 조립합니다.

장치 선택 API는 이 소스 변경에 포함됩니다. 현재 `release-assets.json`은 엔진 `0.4.4`에 고정되어 있으며, 설치 시 해당 버전 archive의 checksum을 검증합니다. Desktop의 신규 native API는 장치 선택을 지원하는 엔진이 필요하며, 구형 엔진에서는 명시 장치 선택을 `unsupported`로 거부합니다. 고객에게 제공하기 전에 고정된 버전의 엔진 archive와 checksum이 발행되어 있는지 확인해야 합니다. 소스 빌드·패키지 검증 통과만으로 새 장치 기능의 배포 완료를 의미하지 않습니다.

Desktop의 마이크·스피커 음소거 API(`setMicMuted`·`setSpeakerMuted`)는 엔진 `0.3.6`부터 지원합니다. 그보다 오래된 엔진에서는 호출하면 `source_mute_unsupported`로 거부합니다.

Desktop의 회의 앱 마이크 동기화 API(`setMeetingSync`·`getMeetingSyncState`·`onMeetingSync`·`getMeetingCandidates`)와 손쉬운 사용 권한 API(`checkAccessibilityPermissionInfo`·`requestAccessibilityPermission`)는 엔진 `0.4.0`부터 지원합니다. 그보다 오래된 엔진에서는 호출하면 `meeting_sync_unsupported`로 거부합니다.

```sh
npm ci --ignore-scripts
npm run build
npm run verify:pre-commit
```

빌드는 SDK 저장소의 소스와 npm 의존성만 사용합니다. 비공개 엔진 저장소 checkout이나 별도 GitHub 토큰 없이 실행할 수 있습니다. 실제 엔진 바이너리·WASM·모델은 설치 시 인증된 release archive로 내려받습니다.

`platforms/*/runtime`, `dist`, 플랫폼별 release manifest·라이선스는 생성 산출물입니다. 실행 래퍼 변경은 `src`에서, 모바일 연결 코드 변경은 `platforms/mobile`에서 수행합니다. Nitro 생성 파일도 저장소에 포함되어 있어 빌드 시 별도 생성 단계가 필요하지 않습니다.

## 배포 패키지 검증

`npm run check:package`는 실제 npm pack 목록에서 공개 진입점, 플랫폼별 의존성, 네이티브 연결 파일과 금지된 바이너리·모델 포함 여부를 검증합니다. 실제 엔진 바이너리와 모델은 인증된 release archive로 별도 설치합니다.

```sh
npm pack --workspace @tellus-ai/audio-sdk-desktop
npm pack --workspace @tellus-ai/audio-sdk-web
npm pack --workspace @tellus-ai/audio-sdk-mobile
```

모든 변경의 완료 조건은 `npm run verify:pre-commit` 통과입니다. 이 명령은 SDK 테스트·JS 구문 검사·세 설치 패키지 검증을 실행합니다.

## 디지털 게인과 자동 보정

새 엔진은 캡처 시작·일시정지·재개·재시도·종료 중 OS 마이크 입력 볼륨을 변경하지 않습니다. 이전의 입력 100% 자동 설정에 의존했다면 OS 입력 수준은 사용자가 정하고, 세션의 처리된 신호만 `micGainDb`로 보정하세요. `micGainDb`와 `speakerGainDb`는 기본 0 dB이며 유한한 -60..+12 dB만 받습니다. 원본 raw PCM, OS 볼륨, SDK 재생 볼륨은 바꾸지 않습니다. `speakerGainDb`는 Desktop에서 캡처한 시스템 오디오에만 적용됩니다. Web·Mobile은 설정의 기본값 0만 허용하고, 0이 아닌 설정 또는 `setSpeakerGainDb()` 호출은 `tellus_speaker_gain_unsupported`로 거부합니다.

Web·Mobile의 `setMicGainDb()`는 Promise를 반환합니다. 설정 대기 중 pause/stop/dispose 또는 승인 취소로 해당 제어 작업이 취소되면 Promise를 reject합니다. 적용되지 않은 변경을 성공으로 처리하지 마세요. 일시정지가 끝난 뒤 새 setter 호출로 다시 요청할 수 있습니다.

`autoGainControl`은 denoise 이후 마이크 신호를 자동 보정하며 기본값은 꺼짐입니다. 명시적으로 `{ enabled: true }`를 전달해야 켜집니다. `maxGainDb` 기본 12(범위 0..30), `maxOutputNoiseLevelDbfs` 기본 -50(-90..0), `maxGainChangeDbPerSecond` 기본 3(0 초과..60), `headroomDb` 기본 6(0..30), `peakLevelDbfs` 기본 -3(-24..0)입니다. 음성 확신과 노이즈 추정에 따라 증가를 제한하고 피크 제한을 적용합니다. 이 기본값은 모든 마이크에 대한 보정값이 아니므로 실제 입력으로 확인하세요. Web·Mobile의 기존 `micAgc2Enabled`는 deprecated 명시 opt-in 별칭입니다. `autoGainControl`을 전달하면 별칭보다 우선하며, 빈 객체도 자동 보정을 켜지 않습니다.

이 기능은 대응하는 새 엔진 바이너리·WASM과 Mobile 네이티브 모듈이 필요합니다. 현재 고정된 release archive를 새 기능의 배포 완료로 해석하지 마세요. Desktop의 구형 엔진은 명시 게인 설정과 setter를 `audio_gain_unsupported`로 거부합니다. SDK 소스 빌드만으로 기존 엔진의 OS 입력 볼륨 동작을 바꿀 수 없습니다.

검증은 `npm run verify:pre-commit`으로 설정 전달, 잘못된 값 거부, Worker 세션 소유권, dispose 이후 명령 취소, 패키지 타입 공개를 확인합니다. 실제 하드웨어 검증 시 시작 전 OS 입력 수준을 기록하고 start/pause/resume/stop 후 같은지 비교하세요. 마이크·시스템 오디오를 각각 녹음해 게인을 바꿔 보고, raw PCM이 있는 Desktop에서는 원본이 유지되는지 확인합니다. 자동 보정은 원본 녹음을 보존한 채 음성·무음·노이즈 구간으로 확인합니다. 이 SDK 테스트는 Windows·iOS·Android 실제 장치 검증을 대신하지 않습니다.

## Desktop 소비 지연과 파일 녹음

`deliveryBufferDurationMs`는 native 콜백 큐의 시간 예산입니다. 명시한 예산을 지원하지 않는 엔진은 `delivery_buffer_unsupported`로 거부합니다. 설치 검증은 manifest·vendor 메타데이터와 실제 `getStatus().engineVersion`이 고정 버전과 일치하는지도 확인합니다.

파일 녹음은 정상 서버 permit을 적용한 idle 상태에서 `enableRecordingBuffer()`를 호출한 뒤 시작합니다. `readRecordingBuffer()`의 `chunks`, `error`, 누적 `droppedChunks`·`droppedSamples`를 검사하고, `stop()` 이후 권한을 해제하기 전에 `queuedChunks === 0`까지 배출합니다. 파일은 콜백 복사본과 중복 저장하지 않습니다. 누락이나 오류가 있으면 불완전 녹음으로 처리합니다. 이 API가 없는 엔진은 `recording_buffer_unsupported`로 거부하며, SDK 버전만으로 지원 여부를 추정하지 않습니다. Windows raw PCM의 `captureClock`·`captureSpans`는 원래 장치 시각 그대로 전달합니다.

`pauseAndDrain()`은 native의 `paused` 확인까지, `resumeWhenReady()`는 `recording` 확인까지 기다립니다. 전환 중 `stop()` 또는 다른 전환이 발생하면 이전 요청은 실패하며, 6초 안에 확인되지 않으면 캡처를 중지하고 오류를 반환합니다. 이 완료 계약은 drain/ready 상태를 구현한 새 native 엔진과 함께 배포해야 합니다. 이전 바이너리가 즉시 `paused`를 반환한다면 wrapper만으로 drain을 보장할 수 없습니다.

raw PCM의 `captureClock`은 Windows의 `windows-qpc`와 macOS의 `macos-monotonic`을 구분합니다. 인코더 tail의 `validSampleCount`는 유효 입력 prefix이며, padding을 실제 입력으로 해석하지 않습니다. 기존 메타데이터를 변환하거나 삭제하지 않고 전달합니다.

## 장치 조회와 선택

각 플랫폼은 `listAudioDevices('microphone' | 'system_audio' | 'playback')`을 제공합니다. 결과는 `{ status, devices: [{ id, label }] }`이며 ID는 조회한 값을 그대로 사용합니다. 이름이나 목록 순서로 장치를 지정하지 않습니다. 조회는 권한 요청이나 임시 캡처를 수행하지 않으며, 목록 조회의 `ready`는 스트림 선택 성공을 보장하지 않습니다. ID는 OS 재시작이나 브라우저 권한 초기화 이후 유지되지 않을 수 있습니다.

설정의 ID를 생략하면 기존 기본 장치를 사용합니다. 명시 ID가 실패하면 기본 장치로 전환하지 않습니다. 장치 선택의 운영 실패를 전달하는 throw/reject 오류에는 `deviceStatus`가 포함되며, 캡처의 `getStatus().deviceStatus`로도 상태를 확인합니다. 상태 코드는 `pending`, `ready`, `unavailable`, `unsupported`, `permission_denied`, `route_mismatch`입니다. 다른 장치로 바꾸려면 새 설정으로 엔진·캡처를 생성하고 승인을 다시 연결합니다. 실행 중 선택 변경 API는 제공하지 않습니다.

## CI 조립

CI는 SDK 저장소를 checkout하고 `npm ci --ignore-scripts` 뒤 동일한 로컬 완료 검증을 실행합니다. 별도 엔진 저장소 접근 설정이 필요하지 않습니다. 배포 workflow는 desktop·web·mobile의 세 tgz와 checksum을 검증한 뒤 기존 버전 파일을 덮어쓰지 않고 S3에 업로드합니다.
