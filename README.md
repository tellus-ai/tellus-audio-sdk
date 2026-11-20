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

Desktop은 OS·CPU에 맞는 엔진을 선택합니다. Web은 웹 엔진만 설치합니다. Mobile은 iOS·Android를 설치하며 `TELLUS_AUDIO_ENGINE_PLATFORM=ios` 또는 `android`로 대상을 제한할 수 있습니다. SDK `0.3.10`은 `release-assets.json`에서 엔진 `0.4.10`을 고정합니다. 앱의 서버 연결을 통해 설치 토큰과 별도의 캡처 실행 승인 토큰을 전달합니다. Web·Mobile 캡처에는 모델 키도 전달합니다.

## 발화 감지

`SpeechDetector`는 마이크에서 현재 발화 여부를 감지합니다. 엔진 v0.4.10이 필요합니다. 감지 기능만 사용하면 서버의 캡처 permit이나 모델 키를 발급받거나 `AudioEngine.init()`을 호출할 필요가 없습니다. SDK 엔진 설치 인증과 OS 마이크 권한은 계속 필요합니다.

[Desktop](platforms/desktop/README.md#발화-감지)은 생성자와 동기 `start`·`stop`, [Web](platforms/web/README.md#발화-감지)과 [React Native](platforms/mobile/README.md#발화-감지)는 비동기 `init`·`start`·`stop`·`dispose`를 제공합니다.

- 이벤트에는 `speaking: boolean`과 `timestampMs: number` 두 필드만 있습니다. `timestampMs`는 각 `start` 이후 처리한 마이크 오디오 길이(ms)이며 벽시계 시각과 무관합니다.
- Silero 32프레임을 1.024초 창으로 묶습니다. 첫 완전한 창과 이후 발화 상태가 바뀔 때 이벤트를 받습니다. 한 창에서 음성으로 판정된 프레임이 50% 이상이면 발화 상태에 들어가고 20% 미만이면 발화 상태에서 벗어납니다.
- 승인과 설정이 유효한 캡처가 시작되면 모든 시작 대기 중·실행 중 감지기를 종료하고 마이크가 해제된 뒤 캡처 입력을 엽니다. 캡처는 시작·실행·일시정지 중 우선권을 유지합니다. 승인 또는 설정 검증에 실패한 캡처는 기존 감지기를 유지합니다.
- 실행 중 선점되면 callback에 `speech_detection_preempted_by_capture` 오류가 한 번 전달되고 이벤트는 생략됩니다. 시작 대기 중 선점되거나 캡처가 이미 우선권을 가진 경우 callback 호출 없이 같은 오류로 `start`가 실패합니다. Desktop은 동기 예외, Web·React Native는 Promise 거부로 알립니다.
- 캡처 종료 후 감지하려면 앱에서 `start`를 다시 호출하세요. `stop`이나 `dispose` 후 도착한 이벤트는 버립니다.

## 유지보수 빌드

SDK 저장소의 실행 래퍼와 설치 코드를 빌드하고 세 플랫폼 패키지를 조립합니다.

Desktop의 신규 native API는 장치 선택을 지원하는 엔진이 필요하며, 구형 엔진에서는 명시 장치 선택을 `unsupported`로 거부합니다. 고객에게 제공하기 전에 고정된 버전의 엔진 archive와 checksum이 발행되어 있는지 확인해야 합니다. 소스 빌드·패키지 검증 통과만으로 새 장치 기능의 배포 완료를 의미하지 않습니다.

Desktop의 마이크·스피커 음소거 API(`setMicMuted`·`setSpeakerMuted`)는 엔진 `0.3.6`부터 지원합니다. 그보다 오래된 엔진에서는 호출하면 `source_mute_unsupported`로 거부합니다.

Desktop의 회의 앱 마이크 동기화 API(`setMeetingSync`·`getMeetingSyncState`·`onMeetingSync`·`getMeetingCandidates`)와 손쉬운 사용 권한 API(`checkAccessibilityPermissionInfo`·`requestAccessibilityPermission`)는 엔진 `0.4.0`부터 지원합니다. 그보다 오래된 엔진에서는 호출하면 `meeting_sync_unsupported`로 거부합니다.

close_talk 설정 `closeTalkThresholdDb`(게이트 임계값, 기본 30)와 `denoiseAttenuationLimitDb`(소음 저감 상한, 기본 12), 런타임 setter `setCloseTalkThresholdDb`·`setDenoiseAttenuationLimitDb`는 세 플랫폼 모두 유한한 0..60 dB만 받습니다. 이 API는 엔진 v0.4.5 이상이 필요하며(SDK 0.3.5부터 고정), 그 전 kit에서는 `unsupported`를 냅니다. 상세는 각 플랫폼 README를 참고하세요.

general 모드는 기본적으로 소음 저감 상한이 없습니다(무제한). `generalDenoiseAttenuationLimitDb`(유한한 0..60 dB 또는 `null`, 기본 `null`)와 런타임 setter `setGeneralDenoiseAttenuationLimitDb`를 지정하면 general 모드에서 입력을 10^(-db/20) 비율로 되섞어 소음 저감을 제한하며, `null`은 무제한으로 되돌립니다. close_talk에는 영향이 없고(`denoiseAttenuationLimitDb`를 그대로 사용), `getStatus()`의 `generalDenoiseAttenuationLimitDb`는 선택 필드입니다. 엔진 v0.4.8 이상이 필요하며, 그 전 kit에서는 설정 값이 `null`이 아닐 때와 setter 호출이 미지원 오류로 실패합니다.

close_talk 게이트 세부 설정 중 `closeTalkLevelMinDbfs`(유한한 -100..0 dBFS, 기본 -20)는 크기 보조(학습 레벨 - 여유 이상이면 열림)를 쓰는 하한으로, 학습한 레벨이 이 값 이상일 때만 크기 보조가 동작합니다. 15-30 cm에서 쓰면 학습 레벨이 -20보다 낮아 크기 보조가 꺼지므로 -32처럼 낮추면 더 작은 학습 음성에서도 동작합니다. 대신 멀거나 작은 목소리, 12 dB 감쇠 한도를 통과한 큰 소음이 게이트를 열 수 있습니다. 엔진 v0.4.9+가 필요하며 구형 엔진에서는 기본값(-20)이 아닌 값을 설정하면 unsupported 오류가 납니다.

그 밖의 close_talk 게이트 세부 설정 `closeTalkHoldMs`(유지 시간, 기본 250, 0..2000 ms), `closeTalkKeepGapDb`(유지 기준 폭, 기본 4, 0..20 dB), `closeTalkLevelMarginDb`(크기 보조 여유, 기본 2, 0..20 dB), `closeTalkLevelMinDbfs`(크기 보조 하한, 기본 -20, -100..0 dBFS, 엔진 v0.4.9+)와 같은 이름의 setter도 세 플랫폼 공통입니다. 학습한 내 말소리 크기는 `getStatus()`의 `closeTalkLearnedLevelDbfs`·`closeTalkLevelLearned`로 읽고, `setCloseTalkLearnedLevelDbfs(값 | null)`(−100..0 dBFS)로 넣거나 지웁니다. 학습값은 이제 소음제거 켜고 끄기, 데스크톱의 모드 전환, pause/resume, stop/start, 마이크 재시작에도 남습니다. 모바일·웹에서 입력 장치를 바꿀 때는 `null`로 지우세요(데스크톱은 다른 마이크가 열리면 스스로 지웁니다). 출력 청크의 `closeTalkGate`(`open`·`openRatio`·`lsnrDb`·`levelDbfs`·`learnedLevelDbfs`)로 게이트 판정을 청크마다 확인할 수 있습니다. 이 API는 엔진 v0.4.8 이상이 필요하며, 그 전 kit에서는 `unsupported`를 냅니다. 상세는 각 플랫폼 README를 참고하세요.

입력 hold API `holdInput()`·`releaseInput()`(상태 `getStatus().inputHeld`)는 앱이 업링크를 끄는 동안(예: TTS 재생) 입력을 보류하는 세 플랫폼 공통 API입니다. 이 API는 엔진 v0.4.6 이상이 필요하며(SDK 0.3.6부터 고정), 그 전 kit에서는 `unsupported` 오류를 냅니다. 상세는 각 플랫폼 README를 참고하세요.

모바일·웹 캡처는 장치 입력 결함으로 멈추지 않습니다. [-1, 1] 밖 유한값(예: iOS 큰 목소리의 1.0 초과)은 ±1로 자르고 NaN·±inf는 0으로 바꾸며(샘플 수·샘플 시계는 그대로), 역행한 timestamp도 받고 청크 timestamp는 뒤로 가지 않습니다. 이전에는 이런 입력 하나로 `internal_error`가 나고 모바일 capture를 다시 만들어야 했습니다. 정규화 수는 `getStatus()`의 `inputClippedSamples`·`inputNonFiniteSamples`·`inputTimestampRegressions`와 같은 이름의 청크 필드로 봅니다. 지원하지 않는 장치 레이트는 계속 실패하며 `invalid_argument`입니다. 실패 원인은 React Native 오류의 `engineMessage`(`message`는 기존 오류 코드 그대로), 웹 오류 `message`의 `코드: 설명`, 두 플랫폼의 `getStatus().lastErrorMessage`로 읽습니다. 모바일의 `internal_error` 잠금은 `reset()` 또는 `stop()` → `start()`가 풀어 같은 capture를 다시 씁니다. 이 동작은 엔진 v0.4.9 이상이 필요하며(필드는 선택 필드), 그 전 kit에서는 설명과 정규화 수가 없습니다.

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

Web 설치 검증에는 공식 엔진 v0.4.10 WASM archive와 checksum 게시가 필요합니다. 게시에는 엔진의 웹 릴리스 빌드 수정이 선행되어야 합니다. [엔진 PR #215](https://github.com/tellus-ai/Tellus-audio-engine/pull/215)

`npm test`는 실제 npm tarball을 별도 소비자 앱에 풀어 패키지 루트의 런타임과 TypeScript 선언을 검사합니다. Desktop의 네이티브 로딩 검사에는 해당 호스트용 엔진을 로컬에 설치해야 합니다. Web·Mobile의 이 검사는 브라우저와 Nitro 경계를 테스트 대역으로 제공합니다.

- Nitro 바인딩을 갱신할 때는 SDK npm 의존성이 설치된 상태에서 `npm run generate:mobile`을 실행합니다.
- POSIX 호스트에서 네이티브 감지와 마이크 인계를 검증하려면 C++20 컴파일러, SDK npm 의존성, 모델이 준비된 엔진 v0.4.10 소스, 테스트 라이선스로 빌드한 호스트 C ABI 라이브러리 및 호환되는 ONNX Runtime이 필요합니다. `TELLUS_ENGINE_TEST_LICENSE=1 ORT_DYLIB_PATH=<host-ort-library> node scripts/test-mobile-speech-native.mjs <engine-source> <host-library-directory>`로 실행합니다. 장치와 플랫폼 리소스 읽기·스레드 연결에는 테스트 대역을 사용합니다.
- 모바일 번들 리소스는 `node scripts/test-mobile-speech-resources.mjs ios` 또는 `node scripts/test-mobile-speech-resources.mjs android`로 검증합니다. iOS 검사는 macOS의 Xcode(iOS Simulator SDK)와 CocoaPods gem이 설치된 Ruby(`RUBY`로 지정 가능)가 필요합니다. Android 검사는 호환 JDK·Gradle(`GRADLE`로 지정 가능)이 필요하며 독립 프로젝트에서 오프라인으로 Gradle 리소스 복사를 실행합니다.

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
