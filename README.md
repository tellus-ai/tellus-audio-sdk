# Tellus Audio SDK

이 저장소는 플랫폼별 설치·패키징·고객 프로젝트 자동 설정을 담당합니다. 실행 구현 원본은 `Tellus-audio-engine/src`에 있습니다.

| 대상 | 설치 패키지 | 문서 |
| --- | --- | --- |
| Electron | `@tellus-ai/audio-sdk-desktop` | [Desktop](platforms/desktop/README.md) |
| 브라우저 | `@tellus-ai/audio-sdk-web` | [Web](platforms/web/README.md) |
| React Native·Expo 개발 앱 | `@tellus-ai/audio-sdk-mobile` | [Mobile](platforms/mobile/README.md) |

각 플랫폼의 `package.json`은 자신의 실행 파일과 의존성만 배포합니다. 기존 단일 패키지의 `/browser`·`/react-native` 진입점은 각 플랫폼 패키지의 기본 진입점으로 이동했습니다. 승인 API는 모든 패키지의 `/authorization`으로 제공합니다. Expo plugin 이름은 `@tellus-ai/audio-sdk-mobile`입니다.

## 설치

고객에게 발급한 `TELLUS_AUDIO_ENGINE_TOKEN`과 HTTPS 서비스 `TELLUS_AUDIO_DOWNLOAD_BASE_URL`을 설정한 뒤 대상 패키지를 설치합니다. 설치된 패키지만 엔진 산출물을 다운로드하고 SHA-256을 검증합니다. 설치 과정은 엔진 저장소나 Rust·TypeScript 소스 빌드를 요구하지 않습니다. root workspace에는 postinstall이 없습니다.

Desktop은 OS·CPU에 맞는 엔진을 선택합니다. Web은 웹 엔진만 설치합니다. Mobile은 iOS·Android를 설치하며 `TELLUS_AUDIO_ENGINE_PLATFORM=ios` 또는 `android`로 대상을 제한할 수 있습니다. 정확한 엔진 버전은 `release-assets.json`에 고정되어 있습니다. 실행 승인 토큰과 모델 키는 설치 토큰과 별개이며 앱의 서버 연결에서 전달합니다.

## 유지보수 빌드

엔진 저장소에서 먼저 플랫폼 실행 산출물을 만듭니다.

```sh
npm ci --ignore-scripts
npm run build:runtime
```

SDK 저장소에서 설치 코드를 빌드하고 해당 산출물로 세 패키지를 조립합니다.

```sh
npm ci --ignore-scripts
npm run build
npm run verify:pre-commit
```

기본 산출물 경로는 형제 저장소 `../Tellus-audio-engine/dist`입니다. 다른 위치는 `TELLUS_AUDIO_ENGINE_DIST` 환경 변수 또는 `node scripts/assemble-platforms.js --engine-dist /absolute/path/to/dist`로 지정합니다. 엔진의 `engine-kit.json` 버전이 SDK pin과 다르면 조립을 중단합니다. SDK 빌드는 엔진 소스를 직접 참조하거나 엔진을 자동 빌드하지 않습니다.

`platforms/*/runtime`, 모바일 `cpp`·`ios`·`android/src`·`nitrogen/generated`, `dist`, 플랫폼별 release manifest·라이선스는 생성 산출물입니다. 이 파일을 SDK에서 수정하지 않습니다. 변경은 엔진 원본에서 수행합니다.

## 배포 패키지 검증

`npm run check:package`는 실제 npm pack 목록에서 공개 진입점, 플랫폼별 의존성, 네이티브 연결 파일과 금지된 바이너리·모델 포함 여부를 검증합니다. 실제 엔진 바이너리와 모델은 인증된 release archive로 별도 설치합니다.

```sh
npm pack --workspace @tellus-ai/audio-sdk-desktop
npm pack --workspace @tellus-ai/audio-sdk-web
npm pack --workspace @tellus-ai/audio-sdk-mobile
```

모든 변경의 완료 조건은 `npm run verify:pre-commit` 통과입니다. 이 명령은 SDK 테스트·JS 구문 검사·세 설치 패키지 검증을 실행합니다.

## CI 조립

CI는 `TELLUS_AUDIO_ENGINE_REF` 저장소 변수의 40자리 commit SHA로 엔진 원본을 고정합니다. `TELLUS_CI_REPOSITORY_TOKEN`에는 엔진 저장소를 읽을 수 있는 최소 권한 토큰을 설정합니다. Checkout은 credentials를 저장하지 않습니다. CI는 해당 엔진의 실행 kit를 생성한 뒤 SDK를 조립하고 동일한 로컬 완료 검증을 실행합니다. 배포 workflow는 desktop·web·mobile의 세 tgz와 checksum을 검증한 뒤 기존 버전 파일을 덮어쓰지 않고 S3에 업로드합니다.
