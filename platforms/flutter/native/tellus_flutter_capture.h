#ifndef TELLUS_FLUTTER_CAPTURE_H
#define TELLUS_FLUTTER_CAPTURE_H

/* The C functions that lib/src (dart:ffi) calls. They wrap the capture session that the React Native
 * SDK uses (platforms/mobile/cpp/CaptureSession), so both SDKs share the OS capture and engine code.
 *
 * Threads: every function may be called from the Dart isolate thread and returns without waiting for
 * audio work. Results arrive through the three callbacks below, which native calls from its own
 * threads. Dart passes NativeCallable.listener pointers, so a callback returns immediately and Dart
 * runs it later on the isolate.
 *
 * Memory: every non-NULL pointer that a callback receives was allocated by native with malloc and
 * now belongs to Dart, which releases it with tellus_flutter_free. Strings are NUL-terminated UTF-8.
 * Pointers passed into a function are borrowed until that function returns.
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TELLUS_FLUTTER_EXPORT __attribute__((visibility("default"))) __attribute__((used))

typedef struct TellusFlutterCapture TellusFlutterCapture;

/* The one reply to a tellus_flutter_capture_call. Success: error_code is NULL and result is the
 * method's result, or NULL when it has none. Failure: error_code is the error code (for example
 * "engine_authorization_required", "capture_disposed", "invalid_argument") and error_message is the
 * engine's explanation or NULL. */
typedef void (*TellusFlutterReply)(int64_t request_id, char *error_code, char *error_message, char *result);

/* One encoded chunk. metadata_json is the engine's chunk metadata, unchanged (see
 * tellus_audio_engine.h: codec, sample_rate, sample, sample_count, valid_sample_count, timestamp,
 * rms and the optional gate_event ...). Before delivering it Dart checks
 * tellus_flutter_capture_can_deliver(epoch, generation), and after handling it, delivered or not,
 * calls tellus_flutter_capture_acknowledge_chunk once. */
typedef void (*TellusFlutterChunk)(int64_t capture_id, uint8_t *payload, uint64_t payload_length,
    char *metadata_json, uint64_t epoch, uint64_t generation);

/* Capture stopped by itself (device lost, authorization expired ...). error_message may be NULL. */
typedef void (*TellusFlutterError)(int64_t capture_id, char *error_code, char *error_message);

/* Creates one capture: an engine session, its worker and the OS audio device. capture_id is chosen
 * by Dart and is passed back to chunk and error. Returns NULL when the session cannot be created. */
TELLUS_FLUTTER_EXPORT TellusFlutterCapture *tellus_flutter_capture_create(int64_t capture_id,
    TellusFlutterReply reply, TellusFlutterChunk chunk, TellusFlutterError error);

/* Runs one method on the capture's worker and answers with exactly one reply(request_id, ...), also
 * for an unknown method or a disposed capture. argument and bytes may be NULL when unused.
 *
 * method                      argument                      number        bytes            result
 * configure                   engine configure JSON         sampleRate    -                -
 * createAuthorizationRequest  conversation ID               -             -                JSON
 * applyAuthorization          permit token                  -             -                authorization status JSON
 * getAuthorizationStatus      -                             -             -                authorization status JSON
 * createModelKeyRequest       -                             -             -                JSON {public_key, native_instance_id}
 * inspectModelFile            model path or resource name   -             -                JSON {model_id, key_id}
 * applyModelKey               model ID + "\n" + key ID      -             80-byte key      -
 * loadModelFile               model path or resource name   -             -                -
 * start                       -                             -             -                -
 * pause                       -                             -             -                -
 * resume                      -                             -             -                -
 * stop                        -                             -             -                -
 * close                       -                             -             -                -
 * getStatus                   -                             -             -                engine status JSON plus last_error_message
 * setDenoiseEnabled           -                             0 or 1        -                -
 *
 * The JSON shapes are those of tellus_audio_engine.h. A model path is a `file://` URL or the name of
 * an SDK resource such as "denoise.temc". start asks for the microphone permission when needed and
 * replies once OS input is open; chunks then arrive through the chunk callback. After the reply to
 * close, native calls no callback for this capture again. */
TELLUS_FLUTTER_EXPORT void tellus_flutter_capture_call(TellusFlutterCapture *capture, int64_t request_id,
    const char *method, const char *argument, double number, const uint8_t *bytes, uint64_t bytes_length);

/* 1 while the engine still allows a chunk of this epoch and authorization generation to be delivered. */
TELLUS_FLUTTER_EXPORT uint8_t tellus_flutter_capture_can_deliver(TellusFlutterCapture *capture,
    uint64_t epoch, uint64_t generation);

/* Tells native that Dart has finished with one chunk, so that it can bound the chunks in flight. */
TELLUS_FLUTTER_EXPORT void tellus_flutter_capture_acknowledge_chunk(TellusFlutterCapture *capture);

/* Drops the permit at once. The engine stops OS capture and pending output. */
TELLUS_FLUTTER_EXPORT void tellus_flutter_capture_invalidate_authorization(TellusFlutterCapture *capture);

/* Frees the capture. Call it after the reply to close; the pointer is invalid afterwards. */
TELLUS_FLUTTER_EXPORT void tellus_flutter_capture_destroy(TellusFlutterCapture *capture);

TELLUS_FLUTTER_EXPORT void tellus_flutter_free(void *pointer);

#ifdef __cplusplus
}
#endif

#endif
