import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'capture.dart';
import 'types.dart';

const _maxRenewIntervalMs = 480000;
const _retryDelayMs = 1000;
const _maxModelRequests = 2;
final _identifier = RegExp(r'^[A-Za-z0-9._-]{1,64}$');
final _publicKey = RegExp(r'^[0-9a-f]{64}$');
// 80 bytes are exactly 107 unpadded base64url characters, and the low 2 bits of the last one are zero.
final _wrappedKey = RegExp(r'^[A-Za-z0-9_-]{106}[AEIMQUYcgkosw048]$');

void _checkModelRequests(List<EngineModelKeyRequest> requests) {
  final models = <String>{};
  if (requests.length > _maxModelRequests ||
      requests.any((request) =>
          !_identifier.hasMatch(request.modelId) ||
          !_identifier.hasMatch(request.keyId) ||
          !_publicKey.hasMatch(request.publicKey) ||
          !models.add(request.modelId))) {
    throw const TellusAudioException('engine_model_key_request_invalid');
  }
}

// The server must answer every requested model exactly once, and nothing else.
List<EngineModelKey> _modelKeys(Map<String, dynamic> message, List<EngineModelKeyRequest> requests) {
  const invalid = TellusAudioException('engine_model_key_response_invalid');
  if (requests.isEmpty && !message.containsKey('model_keys')) return const [];
  final value = message['model_keys'];
  if (value is! List || value.length != requests.length || requests.isEmpty) throw invalid;
  final keys = <EngineModelKey>[];
  for (final key in value) {
    if (key is! Map<String, dynamic>) throw invalid;
    final request =
        requests.where((request) => request.modelId == key['model_id'] && request.keyId == key['key_id']).firstOrNull;
    final wrappedKey = key['wrapped_key'];
    if (request == null ||
        keys.any((applied) => applied.modelId == request.modelId) ||
        wrappedKey is! String ||
        !_wrappedKey.hasMatch(wrappedKey)) {
      throw invalid;
    }
    keys.add(EngineModelKey(modelId: request.modelId, keyId: request.keyId, wrappedKey: wrappedKey));
  }
  return keys;
}

class _PendingRequest {
  int? sequence;
  var applying = false;
  var keys = const <EngineModelKeyRequest>[];
}

class _EngineAuthorization implements EngineAuthorizationController {
  _EngineAuthorization(
      this._socket, this._capture, this._conversationId, this._getAccessToken, this._requestTimeout, this._onError) {
    // A failure before anyone listens to ready must not become an unhandled error.
    _ready.future.ignore();
    _messages = _socket.messages.listen(_onMessage,
        onError: (Object _) => _fail(const TellusAudioException('engine_authorization_connection_failed')));
    void onClose() => _fail(const TellusAudioException('engine_authorization_connection_closed'));
    _socket.done.then((_) => onClose(), onError: (Object _) => onClose());
    // The socket is attached when it is already open, so there is no open event to wait for.
    if (_socket.isOpen) {
      _request('audio.authenticate');
    } else {
      onClose();
    }
  }

  final EngineAuthorizationSocket _socket;
  final AuthorizableAudioCapture _capture;
  final String _conversationId;
  final Future<String> Function() _getAccessToken;
  final Duration _requestTimeout;
  final void Function(TellusAudioException error)? _onError;
  late final StreamSubscription<String> _messages;
  final _ready = Completer<void>();
  var _disposed = false;
  var _approved = false;
  _PendingRequest? _pending;
  // Counts requests and cancellations. Work that started under an older value is abandoned.
  var _attempt = 0;
  Timer? _responseTimer;
  Timer? _renewalTimer;

  @override
  Future<void> get ready => _ready.future;

  @override
  void dispose() => _dispose(const TellusAudioException('engine_authorization_disposed'));

  bool _active(int current) => !_disposed && current == _attempt;

  void _dispose(TellusAudioException error) {
    if (_disposed) return;
    _disposed = true;
    _attempt++;
    _pending = null;
    _responseTimer?.cancel();
    _renewalTimer?.cancel();
    _messages.cancel();
    if (!_approved) _ready.completeError(error);
    _capture.invalidateAuthorization();
  }

  // An authorization failure stops only the native engine; the caller's socket stays open.
  void _fail(Object value) {
    if (_disposed) return;
    final error =
        value is TellusAudioException ? value : TellusAudioException('engine_authorization_failed', engineMessage: '$value');
    _dispose(error);
    if (_approved) _onError?.call(error);
  }

  Future<void> _scheduleRenewal(num delayMs, int current, [void Function()? scheduled]) async {
    try {
      final status = await _capture.getAuthorizationStatus();
      if (!_active(current)) return;
      if (status.state != 'authorized' || status.remainingMs <= 0) {
        throw const TellusAudioException('engine_authorization_expired');
      }
      final delay = [delayMs, _maxRenewIntervalMs, status.remainingMs * 9 ~/ 10].reduce(min);
      _renewalTimer?.cancel();
      _renewalTimer = Timer(Duration(milliseconds: max(1, delay.floor())), () => _request('engine.renew'));
      scheduled?.call();
    } catch (error) {
      if (_active(current)) _fail(error);
    }
  }

  // Before the first approval any failure is final. Afterwards the permit is still valid for a
  // while, so the renewal is tried again.
  void _retryOrFail(Object error) {
    final current = ++_attempt;
    _responseTimer?.cancel();
    _pending = null;
    if (_approved) {
      _scheduleRenewal(_retryDelayMs, current);
    } else {
      _fail(error);
    }
  }

  Future<void> _request(String type) async {
    if (_disposed || _pending != null) return;
    final current = ++_attempt;
    final operation = _pending = _PendingRequest();
    _responseTimer = Timer(_requestTimeout, () => _retryOrFail(const TellusAudioException('engine_authorization_timeout')));
    try {
      final challenge = await _capture.createAuthorizationRequest(_conversationId);
      if (!_active(current)) return;
      operation.sequence = challenge.sequence;
      if (type == 'audio.authenticate') {
        final keys = await _capture.createModelKeyRequests();
        if (!_active(current)) return;
        _checkModelRequests(keys);
        operation.keys = List.of(keys);
      }
      final accessToken = await _getAccessToken();
      if (!_active(current)) return;
      if (!_socket.isOpen || accessToken.isEmpty) throw const TellusAudioException('engine_authentication_required');
      _socket.send(jsonEncode({
        'type': type,
        'version': 1,
        'access_token': accessToken,
        'engine': {'native_instance_id': challenge.nativeInstanceId, 'nonce': challenge.nonce, 'sequence': challenge.sequence},
        if (operation.keys.isNotEmpty)
          'model_keys': [
            for (final key in operation.keys) {'model_id': key.modelId, 'key_id': key.keyId, 'public_key': key.publicKey},
          ],
      }));
    } catch (error) {
      if (_active(current)) _retryOrFail(error);
    }
  }

  void _onMessage(String data) {
    if (_disposed) return;
    final Object? message;
    try {
      message = jsonDecode(data);
    } on FormatException {
      return;
    }
    if (message is! Map<String, dynamic>) return;
    final type = message['type'];
    if (type == 'system.error') {
      _fail(const TellusAudioException('engine_authorization_server_error'));
      return;
    }
    if (type != 'engine.authorized' && type != 'engine.renewed' && type != 'engine.denied') return;
    final current = _attempt;
    try {
      final pending = _pending;
      final sequence = message['sequence'];
      // An approved capture ignores the late answer to a request it has already given up.
      if (sequence is num && _approved && (pending == null || pending.sequence != null && sequence < pending.sequence!)) return;
      if (message['version'] != 1 || pending == null || pending.sequence == null || sequence != pending.sequence) {
        throw const TellusAudioException('engine_authorization_response_mismatch');
      }
      if (type == 'engine.denied') {
        _responseTimer?.cancel();
        _pending = null;
        if (_approved && message['retryable'] == true) {
          _scheduleRenewal(_retryDelayMs, current);
          return;
        }
        final code = message['code'];
        throw TellusAudioException(code is String ? code : 'engine_access_denied');
      }
      if (pending.applying) return;
      final token = message['token'];
      final renewAfterMs = message['renew_after_ms'];
      if (type != (_approved ? 'engine.renewed' : 'engine.authorized') ||
          token is! String ||
          renewAfterMs is! num ||
          !renewAfterMs.isFinite ||
          renewAfterMs <= 0) {
        throw const TellusAudioException('engine_authorization_response_invalid');
      }
      final keys = _modelKeys(message, pending.keys);
      pending.applying = true;
      _apply(token, keys, renewAfterMs, current);
    } catch (error) {
      if (_active(current)) _fail(error);
    }
  }

  // The response timer keeps running here: it also limits how long native may take to apply.
  Future<void> _apply(String token, List<EngineModelKey> keys, num renewAfterMs, int current) async {
    try {
      final status = await _capture.applyAuthorization(token);
      if (_disposed) {
        // dispose invalidated the capture while this permit was still on its way into native.
        _capture.invalidateAuthorization();
        return;
      }
      if (!_active(current)) return;
      if (status.state != 'authorized' || status.remainingMs <= 0) {
        throw const TellusAudioException('engine_authorization_expired');
      }
      if (keys.isNotEmpty) {
        await _capture.applyModelKeys(keys);
        if (!_active(current)) return;
      }
      await _scheduleRenewal(renewAfterMs, current, () {
        _responseTimer?.cancel();
        _pending = null;
        if (!_approved) {
          _approved = true;
          _ready.complete();
        }
      });
    } catch (error) {
      if (_active(current)) _fail(error);
    }
  }
}

/// Binds engine authorization and its renewal to an open `/v1/audio` WebSocket.
///
/// [getAccessToken] is called for the first approval and again for every renewal. [onError] is
/// called when an approved capture later loses its authorization; a failure before the first
/// approval rejects [EngineAuthorizationController.ready] instead.
EngineAuthorizationController attachEngineAuthorization(
  EngineAuthorizationSocket socket,
  AuthorizableAudioCapture capture, {
  required String conversationId,
  required Future<String> Function() getAccessToken,
  Duration requestTimeout = const Duration(seconds: 10),
  void Function(TellusAudioException error)? onError,
}) {
  if (conversationId.isEmpty || requestTimeout <= Duration.zero) {
    throw const TellusAudioException('engine_authorization_invalid_options');
  }
  return _EngineAuthorization(socket, capture, conversationId, getAccessToken, requestTimeout, onError);
}
