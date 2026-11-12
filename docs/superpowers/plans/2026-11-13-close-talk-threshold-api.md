# close_talk threshold·저감 상한 API (SDK) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tellus-audio-sdk의 데스크톱·모바일·웹 패키지에 `closeTalkThresholdDb`·`denoiseAttenuationLimitDb` 설정, `setCloseTalkThresholdDb`·`setDenoiseAttenuationLimitDb` 런타임 setter, `getStatus()`의 두 필드를 추가한다. 구형 엔진 kit에서는 세 플랫폼 모두 런타임 `unsupported` 오류를 낸다.

**Architecture:** 공통 타입(`src/bindings/typescript/capture-types.ts`)에 필드·메서드를 더하고, 데스크톱은 native 바인딩의 메서드 유무로, 웹은 wasm export 유무로, 모바일은 C++ 글루의 약한 참조 resolver로 지원 여부를 판정한다. 모바일·웹은 초기 설정값을 configure JSON에 넣지 않고 configure 뒤 setter로 적용한다.

**Tech Stack:** TypeScript(세 플랫폼 래퍼), C++(SDK 안의 Nitro 글루 사본과 nitrogen 생성물), node:test(`scripts/*.test.js`, `src/platforms/**/*.test.mjs`).

**Spec:** 엔진 저장소 `Tellus-audio-engine` 브랜치 `feat/close-talk-threshold-api`의 `docs/superpowers/specs/2026-11-13-close-talk-threshold-api-design.md`(12절이 저감 상한 추가분). 로컬 경로 `/Users/lucas/workspace/console/.worktrees/Tellus-audio-engine/close-talk-threshold-api/docs/superpowers/specs/2026-11-13-close-talk-threshold-api-design.md`.

## Global Constraints

- 공개 이름.
  - 임계값: `AudioCaptureConfig.closeTalkThresholdDb?: number`, `setCloseTalkThresholdDb(db: number)`(데스크톱 동기 `void`, 모바일·웹 `Promise<void>`), `CaptureStatus.closeTalkThresholdDb?: number`(구형 kit의 상태 JSON에는 키가 없어 `undefined`; doc에 "Absent on engines without close-talk threshold support"). 유한 `0 <= db <= 60`, 엔진 기본 30.
  - 저감 상한: `AudioCaptureConfig.denoiseAttenuationLimitDb?: number`, `setDenoiseAttenuationLimitDb(db: number)`, `CaptureStatus.denoiseAttenuationLimitDb?: number`(같은 이유로 선택적). 유한 `0 <= db <= 60`(양수 dB 크기), 엔진 기본 12.
  - SDK는 기본값을 주입하지 않는다.
- 오류 문자열(정확히 이 값):
  - 데스크톱 잘못된 값: native가 던지는 `invalid_close_talk_threshold_db...` / `invalid_denoise_attenuation_limit_db...`를 그대로 전달. 구형 kit: `close_talk_threshold_unsupported: install a native engine with close-talk threshold support` / `denoise_attenuation_limit_unsupported: install a native engine with denoise attenuation limit support`.
  - 모바일 잘못된 값: `invalid_close_talk_threshold_db` / `invalid_denoise_attenuation_limit_db`. 구형 kit: `tellus_close_talk_threshold_unsupported` / `tellus_denoise_attenuation_limit_unsupported`(C++가 Promise를 거부; JS `typeof` 검사도 같은 문자열).
  - 웹 잘못된 값: `tellus_close_talk_threshold_db_invalid` / `tellus_denoise_attenuation_limit_db_invalid`. 구형 kit: `tellus_close_talk_threshold_unsupported` / `tellus_denoise_attenuation_limit_unsupported`.
- 엔진 C ABI: `tellus_audio_session_set_close_talk_threshold_db(TellusAudioSession*, float)`, `tellus_audio_session_set_denoise_attenuation_limit_db(TellusAudioSession*, float)`; 상태 JSON 키 `close_talk_threshold_db`, `denoise_attenuation_limit_db`; 웹 `native.call`은 `tellus_audio_` 접두어를 붙이므로 `'session_set_close_talk_threshold_db'`, `'session_set_denoise_attenuation_limit_db'`로 부른다.
- 모바일·웹은 설정값을 configure JSON에 넣지 않는다(구형 kit의 `deny_unknown_fields` 때문). configure 뒤 setter로 적용한다.
- 기존 코드 스타일을 따른다(공개 TS doc 주석은 영어, 한 줄 메서드 스타일 유지). 요청 범위 밖은 건드리지 않는다.
- 작업 완료 전 `npm run verify:pre-commit`(= `npm test && npm run check:js && npm run check:package`) 통과.
- `release-assets.json`과 버전은 바꾸지 않는다(별도 릴리즈 PR).

## Review Focus

- 데스크톱에서 설정에 두 키 중 하나를 준 채 구형 native로 생성하면 생성자에서 `unsupported`가 난다 (Task 2·5 테스트).
- 모바일에서 configure JSON에 두 키가 절대 들어가지 않는다 (Task 4·5 테스트).
- 웹에서 `start()` 중 초기값 적용이 configure 뒤·start 전에 각 정확히 한 번 나간다 (Task 3·5 테스트).
- 세 플랫폼의 `getStatus()`가 엔진 상태의 두 값을 그대로 돌려준다 (Task 2·3·4·5 테스트).
- 잘못된 값은 native를 부르기 전에 거부된다 (Task 2·3·4·5 테스트).

---

### Task 1: 공통 타입 (임계값)

**Files:**
- Modify: `src/bindings/typescript/capture-types.ts`

**Interfaces:**
- Produces: `AudioCaptureConfig.closeTalkThresholdDb?: number` (doc: "close_talk gate open threshold in dB, finite 0..=60, engine default 30. Changeable at runtime with setCloseTalkThresholdDb."), `CaptureStatus.closeTalkThresholdDb: number` (doc: "Applied close_talk gate open threshold (dB)."), `AudioCapture.setCloseTalkThresholdDb(db: number): Promise<void>` (doc: "Updates the close_talk gate open threshold from the next 10 ms hop. Rejects with a platform unsupported error on engines without the API.")

- [ ] **Step 1: 타입 추가** — `denoiseMode` 필드 옆에 설정 필드, `denoiseLoadFailed` 옆에 상태 필드, `setMicGainDb` 옆에 메서드.
- [ ] **Step 2: 확인** — Run: `npm run build` (구현 클래스가 인터페이스를 아직 안 만족하면 실패하므로 Task 2~4와 함께 커밋한다.)
- [ ] **Step 3: 커밋** — `git commit -am "feat(types): closeTalkThresholdDb 설정·상태·setter 타입 추가"`

---

### Task 2: 데스크톱 래퍼 (임계값)

**Files:**
- Modify: `src/platforms/desktop/electron/index.ts`
- Create: `scripts/desktop-close-talk-threshold.test.js`

**Interfaces:**
- Consumes: Task 1 타입. native 바인딩 메서드 `setCloseTalkThresholdDb(db)`, `getStatus().closeTalkThresholdDb`.
- Produces: `#requireCloseTalkThresholdSupport()`(`typeof this.#native.setCloseTalkThresholdDb !== 'function'`이면 `throw new Error('close_talk_threshold_unsupported: install a native engine with close-talk threshold support')`), 생성자에서 `config?.closeTalkThresholdDb !== undefined`면 `#requireCloseTalkThresholdSupport()`, `setCloseTalkThresholdDb(db: number): void { this.#requireCloseTalkThresholdSupport(); this.#native.setCloseTalkThresholdDb(db); }`. 설정 필드는 native 생성자 설정에 그대로 전달한다. `getStatus()`는 이미 native 상태를 그대로 돌려주므로 변경 없음.

- [ ] **Step 1: 실패하는 테스트 작성** — `scripts/desktop-gain.test.js`의 `wrapper()` helper를 그대로 복사해 쓴다.

```js
test('desktop close-talk threshold requires a native engine with the setter', () => {
  const AudioCapture = wrapper(class { constructor(config) { this.config = config; } getStatus() { return {}; } });
  assert.throws(() => new AudioCapture({ closeTalkThresholdDb: 25 }), /close_talk_threshold_unsupported: install a native engine with close-talk threshold support/);
  const capture = new AudioCapture({});
  assert.throws(() => capture.setCloseTalkThresholdDb(25), /close_talk_threshold_unsupported/);
});

test('desktop close-talk threshold config and runtime changes reach the owning native capture', () => {
  const calls = [];
  const AudioCapture = wrapper(class {
    constructor(config) { this.config = config; }
    setCloseTalkThresholdDb(db) { calls.push(db); }
    getStatus() { return { closeTalkThresholdDb: 25 }; }
  });
  const capture = new AudioCapture({ closeTalkThresholdDb: 25 });
  assert.equal(capture.getStatus().closeTalkThresholdDb, 25);
  capture.setCloseTalkThresholdDb(22);
  assert.deepEqual(calls, [22]);
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm run build && node --test scripts/desktop-close-talk-threshold.test.js`
- [ ] **Step 3: 구현** — Interfaces대로. `#requireGainSupport`와 같은 자리에 둔다.
- [ ] **Step 4: 통과 확인** — 같은 명령, `pass 2`.
- [ ] **Step 5: 커밋** — `git add src/platforms/desktop/electron/index.ts scripts/desktop-close-talk-threshold.test.js && git commit -m "feat(desktop): closeTalkThresholdDb 설정과 setCloseTalkThresholdDb를 native에 연결"`

---

### Task 3: 웹 래퍼 (임계값)

**Files:**
- Modify: `src/platforms/web/protocol.ts`(워커 명령 타입 `{ operation: 'closeTalkThresholdDb'; db: number }`, `NativeStatus.close_talk_threshold_db: number | null`, `validateCloseTalkThresholdDb`), `src/platforms/web/native.ts`(`supports(name: string): boolean { return typeof (this.module as any)[`_tellus_audio_${name}`] === 'function'; }`), `src/platforms/web/worker.ts`(`case 'closeTalkThresholdDb'`), `src/platforms/web/capture.ts`(`setCloseTalkThresholdDb`, `start()`의 초기값 적용, `getStatus` 매핑)
- Test: `src/platforms/web/worker.test.mjs`, `src/platforms/web/capture.test.mjs`

**Interfaces:**
- Produces:
  - 워커: `case 'closeTalkThresholdDb': if (!native.supports('session_set_close_talk_threshold_db')) throw new Error('tellus_close_talk_threshold_unsupported'); return native.call('session_set_close_talk_threshold_db', [command.db]);`
  - `validateCloseTalkThresholdDb(db: number): number`(유한 0..=60 아니면 `throw new Error('tellus_close_talk_threshold_db_invalid')`), `capture.setCloseTalkThresholdDb(db)`는 검증 뒤 `this.request({ operation: 'closeTalkThresholdDb', db })`.
  - `start()`: configure(세션 생성) 요청이 끝난 직후, `start` 명령 전에 `config.closeTalkThresholdDb !== undefined`면 같은 operation 요청을 한 번 보낸다. `nativeConfig()`에는 키를 넣지 않는다.
  - `getStatus()`에 `closeTalkThresholdDb: status.close_talk_threshold_db`.

- [ ] **Step 1: 실패하는 테스트 작성** — worker.test.mjs의 기존 `micGainDb` 테스트 패턴으로: (a) 모듈 스텁에 `_tellus_audio_session_set_close_talk_threshold_db`가 있으면 `ccall`이 그 이름과 `[25]`로 호출된다, (b) 없으면 `tellus_close_talk_threshold_unsupported`로 reject. capture.test.mjs: (c) `setCloseTalkThresholdDb(61)`은 `tellus_close_talk_threshold_db_invalid`로 reject하고 워커 요청이 없다, (d) `{ closeTalkThresholdDb: 25 }`로 `start()`하면 요청 순서에 configure → `closeTalkThresholdDb`(db 25) → `start`가 각 한 번씩 있다, (e) `getStatus().closeTalkThresholdDb`가 워커 상태의 `close_talk_threshold_db`를 돌려준다, (f) `nativeConfig()` 결과에 `closeTalkThresholdDb` 키가 없다.
- [ ] **Step 2: 실패 확인** — Run: `npm run build && node --test src/platforms/web/worker.test.mjs src/platforms/web/capture.test.mjs`
- [ ] **Step 3: 구현** — Interfaces대로.
- [ ] **Step 4: 통과 확인** — 같은 명령, 모두 `ok`.
- [ ] **Step 5: 커밋** — `git add src/platforms/web && git commit -m "feat(web): closeTalkThresholdDb 설정·setter·상태를 웹 패키지에 추가"`

---

### Task 4: 모바일 래퍼와 native 사본 (임계값)

**Files:**
- Modify: `src/platforms/mobile/react-native/index.ts`, `platforms/mobile/cpp/HybridTellusCapture.hpp`, `platforms/mobile/cpp/HybridTellusCapture.cpp`, `platforms/mobile/nitrogen/generated/shared/c++/HybridTellusCaptureSpec.hpp`, `platforms/mobile/nitrogen/generated/shared/c++/HybridTellusCaptureSpec.cpp`
- Create: `platforms/mobile/cpp/CloseTalkThreshold.hpp`, `platforms/mobile/cpp/CloseTalkThreshold.cpp`
- Test: `src/platforms/mobile/react-native/index.test.mjs`

**Interfaces:**
- Consumes: Task 1 타입.
- Produces:
  - C++: `CloseTalkThreshold.hpp`에 `struct TellusAudioSession; using SetCloseTalkThresholdFn = int32_t (*)(TellusAudioSession*, float); SetCloseTalkThresholdFn resolveSetCloseTalkThresholdDb();` `CloseTalkThreshold.cpp`에 `extern "C" int32_t tellus_audio_session_set_close_talk_threshold_db(TellusAudioSession*, float) __attribute__((weak));`와 resolver 구현(주소가 null이면 nullptr). 엔진 헤더를 포함하지 않는다.
  - `HybridTellusCapture::setCloseTalkThresholdDb(double db)`: 유한 0..=60 아니면 `std::invalid_argument("invalid_close_talk_threshold_db")`; resolver가 nullptr이면 `std::runtime_error("tellus_close_talk_threshold_unsupported")`; 아니면 `submit`에서 `state->check(fn(state->handle, static_cast<float>(db)))`.
  - RN `index.ts`: `async setCloseTalkThresholdDb(db: number): Promise<void>`(`setMicGainDb`와 같은 순서: 검증 `invalid_close_talk_threshold_db` → `controlRevision` → `await this.ready` → `checkControl` → `typeof this.native.setCloseTalkThresholdDb !== 'function'`이면 `tellus_close_talk_threshold_unsupported` → 호출). 생성자: `config.closeTalkThresholdDb !== undefined`면 `ready` 체인 뒤에 setter를 한 번 부른다. configure JSON에 키를 넣지 않는다. `getStatus()`에 `closeTalkThresholdDb: status.close_talk_threshold_db`.

- [ ] **Step 1: 실패하는 테스트 작성** — index.test.mjs의 기존 native 스텁 패턴으로: (a) 스텁에 메서드가 없으면 `tellus_close_talk_threshold_unsupported`로 reject, (b) 있으면 `setCloseTalkThresholdDb(25)`가 한 번 호출, (c) `61`·NaN은 `invalid_close_talk_threshold_db`로 reject하고 native 호출 없음, (d) `{ closeTalkThresholdDb: 25 }`로 만든 엔진은 `configure` JSON에 `closeTalkThresholdDb`가 없고 configure 뒤 setter가 한 번 호출된다, (e) `getStatus().closeTalkThresholdDb`가 `close_talk_threshold_db`를 돌려준다.
- [ ] **Step 2: 실패 확인** — Run: `npm run build && node --test src/platforms/mobile/react-native/index.test.mjs`
- [ ] **Step 3: 구현** — Interfaces대로. C++는 `clang++ -std=c++17 -fsyntax-only`로 문법 검사한다(엔진 헤더에 새 함수가 없는 상태가 구형 kit 상황이다).
- [ ] **Step 4: 통과 확인** — 같은 명령, 모두 `ok`.
- [ ] **Step 5: 커밋** — `git add src/platforms/mobile platforms/mobile && git commit -m "feat(mobile): setCloseTalkThresholdDb를 약한 참조 글루와 RN 래퍼에 추가"`

---

### Task 5: 저감 상한 `denoiseAttenuationLimitDb` — 세 플랫폼과 native 사본

**Files:**
- Modify: `src/bindings/typescript/capture-types.ts`, `src/platforms/desktop/electron/index.ts`, `scripts/desktop-close-talk-threshold.test.js`(테스트 추가), `src/platforms/web/{protocol,native,worker,capture}.ts`, `src/platforms/web/worker.test.mjs`, `src/platforms/web/capture.test.mjs`, `src/platforms/mobile/react-native/index.ts`, `src/platforms/mobile/react-native/index.test.mjs`, `platforms/mobile/cpp/HybridTellusCapture.{hpp,cpp}`, `platforms/mobile/nitrogen/generated/shared/c++/HybridTellusCaptureSpec.{hpp,cpp}`, 약한 참조 TU(Task 4가 만든 `CloseTalkThreshold.{hpp,cpp}`를 `DenoiseSettings.{hpp,cpp}`로 바꾸고 두 resolver를 둔다; `git mv`)

**Interfaces:**
- Consumes: Task 1~4가 만든 임계값 경로. 각 플랫폼에서 임계값과 정확히 같은 모양으로 두 번째 값을 추가한다.
- Produces:
  - 타입: `AudioCaptureConfig.denoiseAttenuationLimitDb?: number`(doc: "close_talk noise attenuation limit in dB (positive magnitude), finite 0..=60, engine default 12. The engine mixes the input back at 10^(-db/20). Changeable at runtime with setDenoiseAttenuationLimitDb; general mode stays unlimited."), `CaptureStatus.denoiseAttenuationLimitDb?: number`(doc: "Applied close_talk noise attenuation limit (dB). Absent on engines without denoise attenuation limit support."), `AudioCapture.setDenoiseAttenuationLimitDb(db: number): Promise<void>`. 같은 커밋에서 Task 1의 `CaptureStatus.closeTalkThresholdDb`도 `?: number`로 바꾸고 doc에 "Absent on engines without close-talk threshold support"를 적고, 웹 `capture.ts`의 non-null 단언(`!`)을 제거한다(검토 판정).
  - 데스크톱: `#requireDenoiseAttenuationLimitSupport()`(`denoise_attenuation_limit_unsupported: install a native engine with denoise attenuation limit support`), 생성자 검사, `setDenoiseAttenuationLimitDb(db: number): void`.
  - 웹: `validateDenoiseAttenuationLimitDb`(`tellus_denoise_attenuation_limit_db_invalid`), 워커 `case 'denoiseAttenuationLimitDb'`(`session_set_denoise_attenuation_limit_db`, 없으면 `tellus_denoise_attenuation_limit_unsupported`), `capture.setDenoiseAttenuationLimitDb`, `start()` 초기값 적용(임계값 요청 다음), `getStatus().denoiseAttenuationLimitDb ← denoise_attenuation_limit_db`.
  - 모바일: `DenoiseSettings.hpp`에 `using DenoiseSettingFn = int32_t (*)(TellusAudioSession*, float); DenoiseSettingFn resolveSetCloseTalkThresholdDb(); DenoiseSettingFn resolveSetDenoiseAttenuationLimitDb();`, `.cpp`에 두 weak 선언과 resolver. `HybridTellusCapture::setDenoiseAttenuationLimitDb(double db)`(`invalid_denoise_attenuation_limit_db` / `tellus_denoise_attenuation_limit_unsupported`). Spec 생성물에 두 번째 메서드. RN `setDenoiseAttenuationLimitDb`, 생성자 초기값 적용, `getStatus().denoiseAttenuationLimitDb ← denoise_attenuation_limit_db`.

- [ ] **Step 1: 실패하는 테스트 작성** — Task 2·3·4의 각 테스트를 두 번째 값으로 복제한다(이름·오류 문자열·값 6 사용). 웹 `start()` 테스트는 configure → closeTalkThresholdDb → denoiseAttenuationLimitDb → start 순서를 단언한다.
- [ ] **Step 2: 실패 확인** — Run: `npm run build && node --test scripts/desktop-close-talk-threshold.test.js src/platforms/web/worker.test.mjs src/platforms/web/capture.test.mjs src/platforms/mobile/react-native/index.test.mjs`
- [ ] **Step 3: 구현** — Interfaces대로. 중복은 각 플랫폼의 기존 검증 helper 모양을 따르되, 두 값 공용 helper를 억지로 만들지 않는다(두 줄짜리 함수 두 개가 더 읽기 쉽다).
- [ ] **Step 4: 통과 확인** — 같은 명령, 모두 `ok`. C++ `-fsyntax-only` 재확인.
- [ ] **Step 5: 커밋** — `git add -A src platforms scripts && git commit -m "feat: denoiseAttenuationLimitDb 설정·setter·상태를 세 플랫폼에 추가"`

---

### Task 6: 문서, 전체 검증, PR

**Files:**
- Modify: `README.md`, `platforms/desktop/README.md`, `platforms/mobile/README.md`, `platforms/web/README.md`

- [ ] **Step 1: 문서** — 각 README에 두 설정(임계값 기본 30, 상한 기본 12, 둘 다 0..60), 두 setter, 두 상태 필드, 플랫폼별 `unsupported` 오류 문자열을 적는다. 루트 README에 "이 API는 다음 엔진 릴리즈(v0.4.4 다음 버전) 이상이 필요하며, 그 전 kit에서는 `unsupported`를 낸다"를 한 문장 적는다.
- [ ] **Step 2: 전체 검증** — Run: `npm run verify:pre-commit` Expected: 종료 코드 0, `# fail 0`.
- [ ] **Step 3: 커밋·푸시·PR** — `git commit -am "docs: closeTalkThresholdDb·denoiseAttenuationLimitDb 설정과 setter 사용법 기록"`, `git push -u origin feat/close-talk-threshold-api`, `gh pr create --base main --title "feat: close_talk 임계값·소음 저감 상한 설정·런타임 setter를 세 플랫폼 SDK에 추가" --body-file <요약·검증 결과·엔진 PR 링크·"새 엔진 kit을 핀하는 릴리즈 PR 전까지는 unsupported" 메모>`. 본문 끝에 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
