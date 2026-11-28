import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:typed_data';

import 'capture.dart';
import 'native.dart';
import 'types.dart';

// Rates libopus encodes. The engine decides; this only fails early at init.
const _opusSampleRates = [8000, 12000, 16000, 24000, 48000];

// 80 bytes are exactly 107 unpadded base64url characters, and the low 2 bits of the last one are zero.
final _wrappedKey = RegExp(r'^[A-Za-z0-9_-]{106}[AEIMQUYcgkosw048]$');

Uint8List _wrappedKeyBytes(String value) {
  if (!_wrappedKey.hasMatch(value)) throw const TellusAudioException('model_key_invalid');
  return base64Url.decode('$value=');
}

// The engine names the VAD model with a `vad` suffix. Every other container is the denoise model.
bool _isVadModel(String modelId) => modelId.endsWith('vad');

// The engine ignores surrounding spaces and case.
String _denoiseMode(AudioCaptureConfig config) => config.denoiseMode.trim().toLowerCase();

/// Creates captures that share one validated [AudioCaptureConfig]. Each capture owns its own
/// authorization, models and processing state.
class AudioEngine {
  AudioEngine._(this._config);

  final AudioCaptureConfig _config;

  /// Validates [config]. Fails with a [TellusAudioException] whose code is `invalid_processing_config`,
  /// `opus_sample_rate_unsupported` or `invalid_denoise_mode`.
  static Future<AudioEngine> init([AudioCaptureConfig config = const AudioCaptureConfig()]) async {
    final rate = config.sampleRate;
    // A 20 ms chunk must be a whole number of samples, or the sample clock drifts.
    if (rate < 8000 || rate > 192000 || rate % 50 != 0) throw const TellusAudioException('invalid_processing_config');
    if (config.codec.trim().toLowerCase() == 'opus' && !_opusSampleRates.contains(rate)) {
      throw const TellusAudioException('opus_sample_rate_unsupported');
    }
    if (!const ['close_talk', 'general'].contains(_denoiseMode(config))) throw const TellusAudioException('invalid_denoise_mode');
    return AudioEngine._(config);
  }

  /// Creates a native capture and starts to configure it. Throws `capture_create_failed` when native
  /// cannot create the session.
  AudioCapture createCapture() => _NativeAudioCapture(_config);
}

/// Connects one OS microphone to an authorized engine session.
class _NativeAudioCapture implements AudioCapture {
  _NativeAudioCapture(this._config) {
    _native = createNativeCapture(_onChunk, _onError);
    _ready = _native.invoke('configure',
        number: _config.sampleRate.toDouble(),
        argument: jsonEncode({
          'sampleRate': _config.sampleRate,
          'denoise': _config.denoiseEnabled,
          'denoiseMode': _denoiseMode(_config),
          'vad': _config.vadEnabled,
          'echoCancellation': _config.echoCancellationEnabled,
          'micAgc2': false,
          'transport': {'codec': _config.codec, if (_config.bitrateBps != null) 'bitrateBps': _config.bitrateBps},
        }));
    // A configure failure is reported by the method that waits for it, not as an unhandled error.
    _ready.ignore();
  }

  final AudioCaptureConfig _config;
  late final NativeCapture _native;
  late final Future<void> _ready;
  var _models = <String, ({String keyId, String path})>{};
  final _loaded = <String>{};
  // Models that failed to load and are skipped so that capture continues without denoise. A model
  // cannot be loaded after the first start, so a new authorization does not try them again.
  final _failed = <String>{};
  AudioCaptureCallback? _callback;
  // _callback receives chunks and errors only while the delivery epoch is still the one it started with.
  var _callbackEpoch = 0;
  var _deliveryEpoch = 0;
  var _controlRevision = 0;
  var _receiving = false;
  var _disposed = false;
  var _sequence = 0;

  // After dispose only `close` may still reach the native capture.
  Future<String?> _call(String method, {String? argument, double number = 0, Uint8List? bytes}) {
    if (_disposed) throw const TellusAudioException('capture_disposed');
    return _native.invoke(method, argument: argument, number: number, bytes: bytes);
  }

  Future<Map<String, dynamic>> _callJson(String method, {String? argument}) async =>
      jsonDecode((await _call(method, argument: argument))!) as Map<String, dynamic>;

  Future<EngineAuthorizationStatus> _authorizationStatus(String method, {String? argument}) async {
    await _ready;
    final status = await _callJson(method, argument: argument);
    return EngineAuthorizationStatus(
      state: status['state'] as String,
      remainingMs: status['remaining_ms'] as int,
      expiresAtMs: status['expires_at_ms'] as int?,
      conversationId: status['conversation_id'] as String?,
      connectionId: status['connection_id'] as String?,
    );
  }

  // A newer lifecycle call or dispose cancels the call that was still waiting.
  void _checkControl(int revision) {
    if (_disposed || revision != _controlRevision) throw const TellusAudioException('capture_cancelled');
  }

  void _onChunk(Uint8List payload, String metadataJson, int epoch, int generation) {
    try {
      final callback = _callback;
      if (_disposed || !_receiving || callback == null || _callbackEpoch != _deliveryEpoch) return;
      final chunk = jsonDecode(metadataJson) as Map<String, dynamic>;
      // Asked last: the engine may have ended this epoch or authorization on another thread meanwhile.
      if (!_native.canDeliver(epoch, generation)) return;
      callback(
        null,
        AudioChunk(
          data: payload,
          codec: chunk['codec'] as String,
          sampleRate: chunk['sample_rate'] as int,
          sample: chunk['sample'] as int,
          sampleCount: chunk['sample_count'] as int,
          validSampleCount: chunk['valid_sample_count'] as int,
          timestamp: chunk['timestamp'] as int,
          rms: (chunk['rms'] as num).toDouble(),
          sequence: _sequence++,
          gateEvent: chunk['gate_event'] as String?,
        ),
      );
    } finally {
      // Native bounds the chunks in flight by these acknowledgements, so every chunk gets exactly one.
      if (!_disposed) _native.acknowledgeChunk();
    }
  }

  void _onError(String code, String? message) {
    final callback = _callback;
    if (_disposed || callback == null || _callbackEpoch != _deliveryEpoch) return;
    _receiving = false;
    callback(TellusAudioException(code, engineMessage: message), null);
  }

  @override
  Future<EngineAuthorizationRequest> createAuthorizationRequest(String conversationId) async {
    await _ready;
    final request = await _callJson('createAuthorizationRequest', argument: conversationId);
    return EngineAuthorizationRequest(
      nativeInstanceId: request['native_instance_id'] as String,
      nonce: request['nonce'] as String,
      sequence: request['sequence'] as int,
    );
  }

  @override
  Future<EngineAuthorizationStatus> applyAuthorization(String token) => _authorizationStatus('applyAuthorization', argument: token);

  @override
  Future<EngineAuthorizationStatus> getAuthorizationStatus() => _authorizationStatus('getAuthorizationStatus');

  @override
  void invalidateAuthorization() {
    ++_controlRevision;
    _receiving = false;
    if (!_disposed) _native.invalidateAuthorization();
  }

  @override
  Future<List<EngineModelKeyRequest>> createModelKeyRequests() async {
    await _ready;
    if (_models.isEmpty) {
      final registry = <String, ({String keyId, String path})>{};
      for (final path in ['denoise.temc', if (_config.vadEnabled) 'vad.temc']) {
        final header = await _callJson('inspectModelFile', argument: path);
        final modelId = header['model_id'] as String;
        if (registry.containsKey(modelId)) throw const TellusAudioException('duplicate_encrypted_model');
        registry[modelId] = (keyId: header['key_id'] as String, path: path);
      }
      // The engine owns the denoise model choice, so only the presence of the VAD model is checked here.
      if (registry.keys.any(_isVadModel) != _config.vadEnabled) throw const TellusAudioException('encrypted_model_binding_invalid');
      _models = registry;
    }
    final publicKey = (await _callJson('createModelKeyRequest'))['public_key'] as String;
    return [
      for (final MapEntry(key: modelId, value: model) in _models.entries)
        if (!_loaded.contains(modelId) && !_failed.contains(modelId))
          EngineModelKeyRequest(modelId: modelId, keyId: model.keyId, publicKey: publicKey),
    ];
  }

  @override
  Future<void> applyModelKeys(List<EngineModelKey> keys) async {
    await _ready;
    for (final key in keys) {
      final model = _models[key.modelId];
      if (model == null || model.keyId != key.keyId) throw const TellusAudioException('model_key_binding_invalid');
      if (_loaded.contains(key.modelId) || _failed.contains(key.modelId)) continue;
      await _call('applyModelKey', argument: '${key.modelId}\n${key.keyId}', bytes: _wrappedKeyBytes(key.wrappedKey));
      try {
        await _call('loadModelFile', argument: model.path);
      } on TellusAudioException catch (error) {
        // Capture continues without denoise when the denoise model cannot be loaded. Only a failure
        // the engine recorded that way is tolerated; key and container errors still throw.
        if (_isVadModel(key.modelId) || (await _callJson('getStatus'))['denoise_load_failed'] != true) rethrow;
        developer.log('denoise_load_failed: capture continues without denoise', name: 'tellus_audio_sdk', error: error);
        _failed.add(key.modelId);
        continue;
      }
      _loaded.add(key.modelId);
    }
  }

  @override
  Future<void> start(AudioCaptureCallback callback) async {
    final revision = ++_controlRevision;
    await _ready;
    _checkControl(revision);
    _callback = callback;
    _callbackEpoch = ++_deliveryEpoch;
    _receiving = true;
    _sequence = 0;
    try {
      await _call('start');
    } catch (_) {
      if (revision == _controlRevision) _receiving = false;
      rethrow;
    }
  }

  @override
  Future<void> pause() async {
    ++_controlRevision;
    _receiving = false;
    await _call('pause');
  }

  @override
  Future<void> resume() async {
    final revision = ++_controlRevision;
    await _ready;
    _checkControl(revision);
    _receiving = true;
    try {
      await _call('resume');
    } catch (_) {
      if (revision == _controlRevision) _receiving = false;
      rethrow;
    }
  }

  @override
  Future<void> stop() async {
    final revision = ++_controlRevision;
    try {
      await _call('stop');
    } finally {
      if (revision == _controlRevision) {
        _receiving = false;
        ++_deliveryEpoch;
      }
    }
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    ++_controlRevision;
    _receiving = false;
    ++_deliveryEpoch;
    try {
      await _native.invoke('close');
    } finally {
      _native.destroy();
    }
  }

  @override
  Future<CaptureStatus> getStatus() async {
    await _ready;
    final status = await _callJson('getStatus');
    return CaptureStatus(
      state: status['lifecycle'] as String,
      denoiseEnabled: status['denoise_enabled'] as bool,
      denoiseMode: status['denoise_mode'] as String?,
      denoiseLoadFailed: status['denoise_load_failed'] as bool,
      vadEnabled: _config.vadEnabled,
      modelsLoaded: _loaded.toList(),
      lastErrorMessage: status['last_error_message'] as String?,
    );
  }

  @override
  Future<void> setDenoiseEnabled(bool enabled) async {
    await _ready;
    await _call('setDenoiseEnabled', number: enabled ? 1 : 0);
  }
}
