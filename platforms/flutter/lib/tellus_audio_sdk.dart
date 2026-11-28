/// Tellus Audio SDK for Flutter (iOS and Android).
///
/// The native engine owns the microphone, denoise and encoding. The app receives encoded transport
/// payloads from [AudioCapture.start] and sends them to the Tellus `/v1/audio` WebSocket, after
/// [attachEngineAuthorization] has approved the capture on that socket.
library;

export 'src/audio_engine.dart' show AudioEngine;
export 'src/authorization.dart' show attachEngineAuthorization;
export 'src/capture.dart';
export 'src/types.dart';
