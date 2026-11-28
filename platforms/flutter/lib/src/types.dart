import 'dart:typed_data';

/// A failure reported by the SDK or the engine.
///
/// [code] is the comparable error code, for example `engine_authorization_required`, `capture_disposed`
/// or `engine_authorization_timeout`. [engineMessage] is the engine's explanation when it gave one.
class TellusAudioException implements Exception {
  const TellusAudioException(this.code, {this.engineMessage});

  final String code;
  final String? engineMessage;

  @override
  String toString() =>
      engineMessage == null || engineMessage!.isEmpty ? 'TellusAudioException: $code' : 'TellusAudioException: $code ($engineMessage)';
}

/// Settings of one capture. The defaults are the engine defaults.
class AudioCaptureConfig {
  const AudioCaptureConfig({
    this.sampleRate = 16000,
    this.codec = 'opus',
    this.bitrateBps,
    this.denoiseEnabled = true,
    this.denoiseMode = 'close_talk',
    this.vadEnabled = true,
    this.echoCancellationEnabled = true,
  });

  /// Output rate of the chunks. Opus accepts 8000, 12000, 16000, 24000 and 48000.
  final int sampleRate;

  /// `opus`, `pcm_s16le` or `pcm_f32le`. Chunks are always 20 ms, mono.
  final String codec;

  /// Opus bitrate. Null uses the engine default. Not allowed with a PCM codec.
  final int? bitrateBps;

  /// Whether DeepFilterNet3 denoise starts on. [AudioCapture.setDenoiseEnabled] changes it later.
  final bool denoiseEnabled;

  /// `close_talk` (silences sound that is not close to the microphone, about 330 ms of delay) or `general`.
  final String denoiseMode;

  /// Whether the engine runs Silero VAD and reports gate events in [AudioChunk.gateEvent].
  final bool vadEnabled;

  final bool echoCancellationEnabled;
}

/// One 20 ms frame of processed microphone audio, encoded for transport.
class AudioChunk {
  const AudioChunk({
    required this.data,
    required this.codec,
    required this.sampleRate,
    required this.sample,
    required this.sampleCount,
    required this.validSampleCount,
    required this.timestamp,
    required this.rms,
    required this.sequence,
    this.gateEvent,
  });

  /// The encoded payload: one Opus packet, or PCM samples.
  final Uint8List data;
  final String codec;
  final int sampleRate;

  /// Position of the first sample on the engine's sample clock.
  final int sample;

  /// Samples this chunk advances the clock by.
  final int sampleCount;

  /// Samples that hold audio. Smaller than [sampleCount] only in the last, padded chunk.
  final int validSampleCount;

  /// Capture time of the first sample, in milliseconds.
  final int timestamp;
  final double rms;

  /// Counts chunks since the last [AudioCapture.start], from 0.
  final int sequence;

  /// `speech_gate_opened` or `speech_gate_closed` when VAD is on and the gate changed in this chunk.
  final String? gateEvent;

  double get durationMs => sampleCount * 1000 / sampleRate;
}

class CaptureStatus {
  const CaptureStatus({
    required this.state,
    required this.denoiseEnabled,
    required this.denoiseMode,
    required this.denoiseLoadFailed,
    required this.vadEnabled,
    required this.modelsLoaded,
    this.lastErrorMessage,
  });

  /// The engine lifecycle: `stopped`, `running` or `paused` once configured.
  final String state;
  final bool denoiseEnabled;
  final String? denoiseMode;

  /// True when the denoise model could not be loaded and capture runs without denoise.
  final bool denoiseLoadFailed;
  final bool vadEnabled;

  /// Model IDs loaded into this capture, for example `dfn3-48`.
  final List<String> modelsLoaded;

  /// The engine's explanation of its last failed call, when there is one.
  final String? lastErrorMessage;
}

/// A fresh challenge generated inside a native capture.
class EngineAuthorizationRequest {
  const EngineAuthorizationRequest({required this.nativeInstanceId, required this.nonce, required this.sequence});

  final String nativeInstanceId;
  final String nonce;
  final int sequence;
}

class EngineAuthorizationStatus {
  const EngineAuthorizationStatus({
    required this.state,
    required this.remainingMs,
    this.expiresAtMs,
    this.conversationId,
    this.connectionId,
  });

  /// `unapproved`, `authorized` or `expired`.
  final String state;
  final int remainingMs;
  final int? expiresAtMs;
  final String? conversationId;
  final String? connectionId;
}

class EngineModelKeyRequest {
  const EngineModelKeyRequest({required this.modelId, required this.keyId, required this.publicKey});

  final String modelId;
  final String keyId;

  /// 64 lowercase hex characters.
  final String publicKey;
}

class EngineModelKey {
  const EngineModelKey({required this.modelId, required this.keyId, required this.wrappedKey});

  final String modelId;
  final String keyId;

  /// Unpadded base64url form of the 80-byte HPKE wrapped key (107 characters).
  final String wrappedKey;
}
