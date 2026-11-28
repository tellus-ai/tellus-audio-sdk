import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:tellus_audio_sdk/src/native.dart';
import 'package:tellus_audio_sdk/tellus_audio_sdk.dart';

final _publicKey = 'ab' * 32;
final _keyBytes = List.generate(80, (index) => 255 - index);
final _wrappedKey = base64Url.encode(_keyBytes).replaceAll('=', '');

String _status({bool denoiseLoadFailed = false}) => jsonEncode({
      'lifecycle': 'stopped',
      'denoise_enabled': !denoiseLoadFailed,
      'denoise_mode': 'close_talk',
      'denoise_load_failed': denoiseLoadFailed,
      'last_error_message': denoiseLoadFailed ? 'model_load_failed' : null,
    });

Matcher _throwsCode(String code) => throwsA(isA<TellusAudioException>().having((error) => error.code, 'code', code));

/// Stands in for the native capture. A reply is a result string, a [TellusAudioException] to fail
/// with, or a [Completer] to answer later. `method argument` is looked up before `method`.
class _Native implements NativeCapture {
  _Native(this.onChunk, this.onError, Map<String, Object?> replies) {
    this.replies.addAll(replies);
  }

  final NativeChunkHandler onChunk;
  final NativeErrorHandler onError;
  final calls = <({String method, String? argument, double number, Uint8List? bytes})>[];
  final replies = <String, Object?>{
    'getStatus': _status(),
    'createModelKeyRequest': jsonEncode({'public_key': _publicKey, 'native_instance_id': 'cd' * 32}),
    'inspectModelFile denoise.temc': jsonEncode({'model_id': 'dfn3-48', 'key_id': 'key-d'}),
    'inspectModelFile vad.temc': jsonEncode({'model_id': 'silero-vad', 'key_id': 'key-v'}),
  };
  final deliveryChecks = <(int, int)>[];
  var deliverable = true;
  var acknowledged = 0;
  var invalidated = 0;
  var destroyed = false;

  List<String> get methods => [for (final call in calls) call.method];

  void chunk([Map<String, Object?> extra = const {}]) => onChunk(
      Uint8List.fromList([1, 2, 3]),
      jsonEncode({
        'codec': 'opus',
        'sample_rate': 16000,
        'sample': 640,
        'sample_count': 320,
        'valid_sample_count': 320,
        'timestamp': 1234,
        'rms': 0,
        ...extra,
      }),
      7,
      3);

  @override
  Future<String?> invoke(String method, {String? argument, double number = 0, Uint8List? bytes}) async {
    calls.add((method: method, argument: argument, number: number, bytes: bytes));
    final reply = replies['$method $argument'] ?? replies[method];
    if (reply is TellusAudioException) throw reply;
    if (reply is Completer<String?>) return reply.future;
    return reply as String?;
  }

  @override
  bool canDeliver(int epoch, int generation) {
    deliveryChecks.add((epoch, generation));
    return deliverable;
  }

  @override
  void acknowledgeChunk() => acknowledged++;

  @override
  void invalidateAuthorization() => invalidated++;

  @override
  void destroy() => destroyed = true;
}

void main() {
  late _Native native;
  late Map<String, Object?> replies;

  setUp(() {
    replies = {};
    createNativeCapture = (onChunk, onError) => native = _Native(onChunk, onError, replies);
  });

  Future<AudioCapture> createCapture([AudioCaptureConfig config = const AudioCaptureConfig()]) async =>
      (await AudioEngine.init(config)).createCapture();

  test('init validates the output rate, the Opus rate and the denoise mode', () async {
    for (final rate in [7950, 192050, 16025]) {
      await expectLater(
          AudioEngine.init(AudioCaptureConfig(sampleRate: rate, codec: 'pcm_s16le')), _throwsCode('invalid_processing_config'));
    }
    await expectLater(AudioEngine.init(const AudioCaptureConfig(sampleRate: 44100)), _throwsCode('opus_sample_rate_unsupported'));
    await expectLater(
        AudioEngine.init(const AudioCaptureConfig(sampleRate: 44100, codec: ' OPUS ')), _throwsCode('opus_sample_rate_unsupported'));
    await AudioEngine.init(const AudioCaptureConfig(sampleRate: 44100, codec: 'pcm_s16le'));
    await expectLater(AudioEngine.init(const AudioCaptureConfig(denoiseMode: 'far_field')), _throwsCode('invalid_denoise_mode'));
    await AudioEngine.init(const AudioCaptureConfig(denoiseMode: ' General '));
  });

  test('a capture configures the engine when it is created', () async {
    await createCapture();
    expect(native.calls.single.method, 'configure');
    expect(native.calls.single.number, 16000);
    expect(jsonDecode(native.calls.single.argument!), {
      'sampleRate': 16000,
      'denoise': true,
      'denoiseMode': 'close_talk',
      'vad': true,
      'echoCancellation': true,
      'micAgc2': false,
      'transport': {'codec': 'opus'},
    });

    await createCapture(const AudioCaptureConfig(
        sampleRate: 48000,
        bitrateBps: 32000,
        denoiseEnabled: false,
        denoiseMode: ' General ',
        vadEnabled: false,
        echoCancellationEnabled: false));
    expect(native.calls.single.number, 48000);
    expect(jsonDecode(native.calls.single.argument!), {
      'sampleRate': 48000,
      'denoise': false,
      'denoiseMode': 'general',
      'vad': false,
      'echoCancellation': false,
      'micAgc2': false,
      'transport': {'codec': 'opus', 'bitrateBps': 32000},
    });
  });

  test('a configure failure fails the calls that wait for it', () async {
    replies['configure'] = const TellusAudioException('invalid_argument');
    final capture = await createCapture();
    // Nobody waits for the configuration yet. An unhandled error would fail this test here.
    await pumpEventQueue();
    await expectLater(capture.getStatus(), _throwsCode('invalid_argument'));
    await expectLater(capture.start((error, chunk) {}), _throwsCode('invalid_argument'));
    expect(native.methods, ['configure']);
  });

  test('model keys are requested for the bundled models, applied as 80 bytes and loaded once', () async {
    final capture = await createCapture();
    final requests = await capture.createModelKeyRequests();
    expect([for (final request in requests) (request.modelId, request.keyId, request.publicKey)],
        [('dfn3-48', 'key-d', _publicKey), ('silero-vad', 'key-v', _publicKey)]);

    await capture.applyModelKeys([
      EngineModelKey(modelId: 'dfn3-48', keyId: 'key-d', wrappedKey: _wrappedKey),
      EngineModelKey(modelId: 'silero-vad', keyId: 'key-v', wrappedKey: _wrappedKey),
    ]);
    expect([for (final call in native.calls.skip(4)) (call.method, call.argument)], [
      ('applyModelKey', 'dfn3-48\nkey-d'),
      ('loadModelFile', 'denoise.temc'),
      ('applyModelKey', 'silero-vad\nkey-v'),
      ('loadModelFile', 'vad.temc'),
    ]);
    expect(native.calls[4].bytes, _keyBytes);
    expect((await capture.getStatus()).modelsLoaded, ['dfn3-48', 'silero-vad']);
    expect(await capture.createModelKeyRequests(), isEmpty);
  });

  test('a key for another binding or with a malformed value is rejected before it reaches native', () async {
    final capture = await createCapture(const AudioCaptureConfig(vadEnabled: false));
    expect((await capture.createModelKeyRequests()).single.modelId, 'dfn3-48');
    for (final (keyId, wrappedKey, code) in [
      ('other-key', _wrappedKey, 'model_key_binding_invalid'),
      ('key-d', _wrappedKey.substring(1), 'model_key_invalid'),
      // The last character may not carry bits beyond the 80th byte.
      ('key-d', '${_wrappedKey.substring(0, 106)}B', 'model_key_invalid'),
    ]) {
      await expectLater(
          capture.applyModelKeys([EngineModelKey(modelId: 'dfn3-48', keyId: keyId, wrappedKey: wrappedKey)]), _throwsCode(code));
    }
    expect(native.methods, isNot(contains('applyModelKey')));
  });

  test('the bundled models must be distinct and include a VAD model only when VAD is on', () async {
    replies['inspectModelFile vad.temc'] = jsonEncode({'model_id': 'dfn3-48', 'key_id': 'key-v'});
    await expectLater((await createCapture()).createModelKeyRequests(), _throwsCode('duplicate_encrypted_model'));
    replies['inspectModelFile vad.temc'] = jsonEncode({'model_id': 'other-model', 'key_id': 'key-v'});
    await expectLater((await createCapture()).createModelKeyRequests(), _throwsCode('encrypted_model_binding_invalid'));
  });

  test('a denoise model that the engine could not load is skipped; any other load failure throws', () async {
    final keys = [
      EngineModelKey(modelId: 'dfn3-48', keyId: 'key-d', wrappedKey: _wrappedKey),
      EngineModelKey(modelId: 'silero-vad', keyId: 'key-v', wrappedKey: _wrappedKey),
    ];
    replies['loadModelFile denoise.temc'] = const TellusAudioException('model_load_failed');
    replies['getStatus'] = _status(denoiseLoadFailed: true);
    var capture = await createCapture();
    await capture.createModelKeyRequests();
    await capture.applyModelKeys(keys);
    final status = await capture.getStatus();
    expect(status.denoiseLoadFailed, isTrue);
    expect(status.modelsLoaded, ['silero-vad']);
    expect(await capture.createModelKeyRequests(), isEmpty);

    // The engine did not record a denoise load failure, so the error is a key or container error.
    replies['getStatus'] = _status();
    capture = await createCapture();
    await capture.createModelKeyRequests();
    await expectLater(capture.applyModelKeys(keys), _throwsCode('model_load_failed'));

    replies
      ..remove('loadModelFile denoise.temc')
      ..['loadModelFile vad.temc'] = const TellusAudioException('model_load_failed')
      ..['getStatus'] = _status(denoiseLoadFailed: true);
    capture = await createCapture();
    await capture.createModelKeyRequests();
    await expectLater(capture.applyModelKeys(keys), _throwsCode('model_load_failed'));
  });

  test('chunks are parsed, counted from each start and acknowledged once, delivered or not', () async {
    final capture = await createCapture();
    final chunks = <AudioChunk>[];
    final errors = <TellusAudioException>[];
    void callback(TellusAudioException? error, AudioChunk? chunk) => error == null ? chunks.add(chunk!) : errors.add(error);

    await capture.start(callback);
    native.chunk();
    native.chunk({'gate_event': 'speech_gate_opened', 'rms': 0.25});
    expect(native.deliveryChecks, [(7, 3), (7, 3)]);
    final first = chunks.first;
    expect(first.data, [1, 2, 3]);
    expect([first.codec, first.sampleRate, first.sample, first.sampleCount, first.validSampleCount, first.timestamp],
        ['opus', 16000, 640, 320, 320, 1234]);
    expect([first.rms, first.sequence, first.gateEvent, first.durationMs], [0.0, 0, null, 20.0]);
    expect([chunks.last.rms, chunks.last.sequence, chunks.last.gateEvent], [0.25, 1, 'speech_gate_opened']);

    native.deliverable = false;
    native.chunk();
    native.deliverable = true;
    await capture.pause();
    native.chunk();
    expect(chunks, hasLength(2));
    await capture.resume();
    native.chunk();
    expect(chunks.last.sequence, 2);
    await capture.stop();
    native.chunk();
    // stop ended the delivery of this start, so a resume without a new start delivers nothing.
    await capture.resume();
    native.chunk();
    expect(chunks, hasLength(3));
    expect(native.acknowledged, 7);

    await capture.start(callback);
    native.chunk();
    expect(chunks.last.sequence, 0);
    native.onError('device_lost', 'the microphone was unplugged');
    expect([errors.single.code, errors.single.engineMessage], ['device_lost', 'the microphone was unplugged']);
    native.chunk();
    expect(chunks, hasLength(4));
    expect(native.acknowledged, 9);

    // A disposed capture frees what still arrives but calls no native function for it.
    await capture.start(callback);
    await capture.dispose();
    native.chunk();
    native.onError('device_lost', null);
    expect(chunks, hasLength(4));
    expect(errors, hasLength(1));
    expect(native.acknowledged, 9);
    expect(native.deliveryChecks, hasLength(5));
  });

  test('dispose closes the native capture, destroys it after the reply and blocks later native calls', () async {
    final close = replies['close'] = Completer<String?>();
    final capture = await createCapture();
    await capture.getStatus();
    final disposed = capture.dispose();
    await pumpEventQueue();
    expect(native.methods.last, 'close');
    expect(native.destroyed, isFalse);
    close.complete(null);
    await disposed;
    expect(native.destroyed, isTrue);

    await capture.dispose();
    await expectLater(capture.getStatus(), _throwsCode('capture_disposed'));
    await expectLater(capture.pause(), _throwsCode('capture_disposed'));
    await expectLater(capture.start((error, chunk) {}), _throwsCode('capture_cancelled'));
    capture.invalidateAuthorization();
    expect(native.invalidated, 0);
    expect(native.methods, ['configure', 'getStatus', 'close']);
  });
}
