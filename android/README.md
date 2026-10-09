# Android adapter

Android API 24 이상에서 `AudioRecord` PCM float mono 입력을 전용 읽기 thread로 전달한다.
입력의 실제 부분 읽기 길이만 JNI에서 복사하고, 추론·VAD·Opus는 공통 native worker가 처리한다.
`AudioTrack`의 실제 수락 sample만 AEC 참조로 전달하며 마지막 sample이 재생된 뒤 완료한다.

- foreground Activity에서 시작하면 SDK가 `RECORD_AUDIO` runtime 권한을 요청한다. 거부·60초 응답 없음은 시작 실패이며, 권한 응답 후에도 엔진 승인을 다시 확인하고 microphone을 연다.
- 시작한 캡처는 microphone foreground service로 background에서 유지한다. 중단·포커스 손실·장치 경로 변경은 오류를 전달하고 명시적 재시작이 필요하다.
- `setRecordingNotification`으로 제목·내용과 선택적 pause/resume callback을 지정할 수 있다. 설정한 경우 사용자 pause는 단일 FGS 알림을 유지하고 resume는 기존 service를 재사용한다. 버튼은 앱 callback만 전달하며 앱이 `pause()`/`resume()`를 호출한다. stop·dispose·오류는 알림과 action을 제거한다.
- 엔진 artifact는 `vendor/android/include/tellus_audio_engine.h`와 `jniLibs/{arm64-v8a,x86_64}/libtellus_audio_engine.so`가 필요하다. host 앱의 `reactNativeArchitectures`도 지원하는 ABI로 설정한다.
- MP3/WAV는 OS MediaExtractor/MediaCodec로 mono PCM을 만들며 입력16MiB·출력4M sample 상한을 지킨다. private cache 파일은 성공·실패·취소 이후 삭제한다.
- ONNX Runtime은 1.24.3을 사용한다. 모델은 `models/*.temc`만 asset `tellus-audio-sdk/`에 복사한다. `file:///absolute/path`, `asset://tellus-audio-sdk/name.temc` 또는 `name.temc`로 읽는다.

Expo prebuild 또는 React Native Android host의 `android/`에서 전체 adapter 검증을 실행한다.

```sh
./gradlew :tellus-ai_audio-sdk:compileDebugKotlin :tellus-ai_audio-sdk:externalNativeBuildDebug :tellus-ai_audio-sdk:testDebugUnitTest -PreactNativeArchitectures=arm64-v8a,x86_64
```

캡처 권한, background 유지, interrupt, route 변경과 실제 음향 AEC는 연결된 Android 기기에서 확인해야 한다.
프레임워크 API compile 또는 JNI object compile은 이 실행 검증을 대신하지 않는다.

공식 계약: [AudioRecord direct read](https://developer.android.com/reference/android/media/AudioRecord#read(java.nio.ByteBuffer,int,int)),
[AudioTrack write](https://developer.android.com/reference/android/media/AudioTrack#write(java.nio.ByteBuffer,int,int)),
[microphone foreground service](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone),
[audio focus](https://developer.android.com/media/optimize/audio-focus),
[notification action](https://developer.android.com/reference/android/app/Notification.Action.Builder),
[SONAME 없는 engine의 이름 링크](https://cmake.org/cmake/help/latest/prop_tgt/IMPORTED_NO_SONAME.html),
[immutable PendingIntent와 cancel](https://developer.android.com/reference/android/app/PendingIntent),
[MediaCodec PCM](https://developer.android.com/reference/android/media/MediaCodec#RawAudioBuffers),
[MediaFormat PCM encoding](https://developer.android.com/reference/android/media/MediaFormat#KEY_PCM_ENCODING).
