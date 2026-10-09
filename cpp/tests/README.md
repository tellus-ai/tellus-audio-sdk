# Native worker 검증

다음 명령은 실제 FIFO 구현을 OS·Rust 추론 없이 검증한다. seed가 고정된 1,000개 손실 분할과 100개 부분 I/O 입력에서 처리 cursor, 원본 복사, 16개 frame 상한을 확인하며 종료 시 제어 Promise가 남지 않는지도 검사한다.

```sh
env TMPDIR=/private/tmp c++ -std=c++20 -Wall -Wextra -Werror -pthread -I cpp cpp/tests/capture-worker.test.cpp cpp/CaptureWorker.cpp -o /tmp/tellus-capture-worker-test
/tmp/tellus-capture-worker-test
```

다음 경계 테스트는 호스트용 실제 Rust C ABI 라이브러리와 Nitro·RN JSI를 링크한다. OS 장치만 double로 바꾸며 승인 전 권한 요청 차단, 요청 중 승인 취소, 동일 capture 재승인, 재생·디코딩 취소, 8개 제어 큐 포화 상태의 OS 정리를 확인한다. 공개 CI 서명 키로 빌드한 테스트 전용 엔진만 사용한다.

```sh
TELLUS_ENGINE_TEST_LICENSE=1 node cpp/tests/run-session-test.mjs \
  /path/to/Tellus-audio-engine /path/to/host-library-directory \
  /path/to/react-native/ReactCommon/jsi
```

기기·시뮬레이터 검증은 OS 권한 거부와 요청 도중 종료, 승인 만료, pause/reset/재승인 뒤 늦은 callback, 재생 도중 취소와 실제 완료를 포함해야 한다. 이 실행 파일은 해당 기기 검증을 대신하지 않는다.
