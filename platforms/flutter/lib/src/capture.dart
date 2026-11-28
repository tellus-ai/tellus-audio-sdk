import 'types.dart';

/// Receives either an error or a chunk, never both. After an error the capture has stopped delivering.
typedef AudioCaptureCallback = void Function(TellusAudioException? error, AudioChunk? chunk);

/// The part of a capture that [attachEngineAuthorization] drives. The native engine is the final
/// authority: the transport never verifies a permit itself.
abstract interface class AuthorizableAudioCapture {
  Future<EngineAuthorizationRequest> createAuthorizationRequest(String conversationId);
  Future<EngineAuthorizationStatus> applyAuthorization(String token);
  Future<EngineAuthorizationStatus> getAuthorizationStatus();

  /// Drops the permit. The engine stops OS capture and pending output.
  void invalidateAuthorization();

  /// Key requests for the encrypted models this capture has not loaded yet.
  Future<List<EngineModelKeyRequest>> createModelKeyRequests();

  /// Applies the wrapped keys and loads their models.
  Future<void> applyModelKeys(List<EngineModelKey> keys);
}

/// One OS microphone connected to an authorized engine session.
abstract interface class AudioCapture implements AuthorizableAudioCapture {
  /// Asks for the microphone permission if needed and starts capture. Needs a valid authorization.
  Future<void> start(AudioCaptureCallback callback);
  Future<void> pause();
  Future<void> resume();

  /// Stops capture. The last chunks are delivered before the future completes.
  Future<void> stop();

  /// Releases the native capture. The object cannot be used afterwards.
  Future<void> dispose();
  Future<CaptureStatus> getStatus();
  Future<void> setDenoiseEnabled(bool enabled);
}

/// The `/v1/audio` WebSocket as [attachEngineAuthorization] uses it. The app keeps ownership of the
/// socket and keeps sending audio on it.
abstract interface class EngineAuthorizationSocket {
  /// Whether a text frame can be sent now.
  bool get isOpen;

  /// The text frames from the server. [attachEngineAuthorization] listens to it once, so give it a
  /// stream that the app's own listener does not consume (for example a broadcast stream).
  Stream<String> get messages;

  /// Completes when the socket has closed, for any reason.
  Future<void> get done;

  void send(String text);
}

abstract interface class EngineAuthorizationController {
  /// Completes after the engine has applied the first permit and every requested model key.
  Future<void> get ready;

  /// Stops renewal and invalidates the native permit, which stops capture. The socket stays open.
  void dispose();
}
