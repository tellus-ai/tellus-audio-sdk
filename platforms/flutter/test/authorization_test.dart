// fake_async is a dependency of flutter_test, so this package does not list it a second time.
// ignore_for_file: depend_on_referenced_packages

import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tellus_audio_sdk/tellus_audio_sdk.dart';

final _publicKey = 'ab' * 32;
final _wrappedKey = 'A' * 107;
final _modelRequest = EngineModelKeyRequest(modelId: 'dfn3-48', keyId: 'key-1', publicKey: _publicKey);

Matcher _hasCode(String code) => isA<TellusAudioException>().having((error) => error.code, 'code', code);

class _Socket implements EngineAuthorizationSocket {
  final sent = <Map<String, dynamic>>[];
  final _messages = StreamController<String>.broadcast(sync: true);
  final _done = Completer<void>();

  @override
  bool isOpen = true;

  @override
  Stream<String> get messages => _messages.stream;

  @override
  Future<void> get done => _done.future;

  @override
  void send(String text) => sent.add(jsonDecode(text) as Map<String, dynamic>);

  void receive(Map<String, Object?> message) => _messages.add(jsonEncode(message));

  void close() {
    isOpen = false;
    _done.complete();
  }
}

class _Capture implements AuthorizableAudioCapture {
  var sequence = 0;
  var remainingMs = 600000;
  var modelRequests = <EngineModelKeyRequest>[];
  var authorized = false;
  var invalidations = 0;
  final appliedTokens = <String>[];
  final appliedKeys = <EngineModelKey>[];

  @override
  Future<EngineAuthorizationRequest> createAuthorizationRequest(String conversationId) async =>
      EngineAuthorizationRequest(nativeInstanceId: 'instance-$conversationId', nonce: 'nonce-${++sequence}', sequence: sequence);

  @override
  Future<EngineAuthorizationStatus> applyAuthorization(String token) {
    appliedTokens.add(token);
    authorized = true;
    return getAuthorizationStatus();
  }

  @override
  Future<EngineAuthorizationStatus> getAuthorizationStatus() async =>
      EngineAuthorizationStatus(state: authorized ? 'authorized' : 'unapproved', remainingMs: authorized ? remainingMs : 0);

  @override
  void invalidateAuthorization() {
    invalidations++;
    authorized = false;
  }

  @override
  Future<List<EngineModelKeyRequest>> createModelKeyRequests() async => modelRequests;

  @override
  Future<void> applyModelKeys(List<EngineModelKey> keys) async => appliedKeys.addAll(keys);
}

/// One attached controller on a fake clock. It records how `ready` ended and what `onError` received.
class _Session {
  _Session(this.async, {_Capture? capture, Duration requestTimeout = const Duration(seconds: 10)})
      : capture = capture ?? _Capture() {
    controller = attachEngineAuthorization(socket, this.capture,
        conversationId: 'conversation',
        getAccessToken: () async => 'access-${++_accessTokens}',
        requestTimeout: requestTimeout,
        onError: errors.add);
    controller.ready.then((_) {
      ready = true;
    }, onError: (Object error) {
      readyError = error;
    });
    async.flushMicrotasks();
  }

  final FakeAsync async;
  final _Capture capture;
  final socket = _Socket();
  final errors = <TellusAudioException>[];
  late final EngineAuthorizationController controller;
  var ready = false;
  Object? readyError;
  var _accessTokens = 0;

  /// Answers the request that is waiting, as the server would.
  void answer(String type, [Map<String, Object?> fields = const {}]) {
    socket.receive({'type': type, 'version': 1, 'sequence': capture.sequence, ...fields});
    async.flushMicrotasks();
  }

  void approve({num renewAfterMs = 60000}) =>
      answer(ready ? 'engine.renewed' : 'engine.authorized', {'token': 'permit-${capture.sequence}', 'renew_after_ms': renewAfterMs});

  void elapse(int milliseconds) => async.elapse(Duration(milliseconds: milliseconds));
}

void main() {
  test('the first approval sends the challenge and the model-key requests, then applies the permit and the keys', () {
    fakeAsync((async) {
      final session = _Session(async, capture: _Capture()..modelRequests = [_modelRequest]);
      expect(session.socket.sent.single, {
        'type': 'audio.authenticate',
        'version': 1,
        'access_token': 'access-1',
        'engine': {'native_instance_id': 'instance-conversation', 'nonce': 'nonce-1', 'sequence': 1},
        'model_keys': [
          {'model_id': 'dfn3-48', 'key_id': 'key-1', 'public_key': _publicKey},
        ],
      });
      expect(session.ready, isFalse);

      session.answer('engine.authorized', {
        'token': 'permit',
        'renew_after_ms': 60000,
        'model_keys': [
          {'model_id': 'dfn3-48', 'key_id': 'key-1', 'wrapped_key': _wrappedKey},
        ],
      });
      expect(session.ready, isTrue);
      expect(session.capture.appliedTokens, ['permit']);
      final key = session.capture.appliedKeys.single;
      expect([key.modelId, key.keyId, key.wrappedKey], ['dfn3-48', 'key-1', _wrappedKey]);
      session.controller.dispose();
    });
  });

  test('a model-key answer that does not match the request rejects ready', () {
    fakeAsync((async) {
      final session = _Session(async, capture: _Capture()..modelRequests = [_modelRequest]);
      session.answer('engine.authorized', {
        'token': 'permit',
        'renew_after_ms': 60000,
        'model_keys': [
          {'model_id': 'dfn3-48', 'key_id': 'other-key', 'wrapped_key': _wrappedKey},
        ],
      });
      expect(session.readyError, _hasCode('engine_model_key_response_invalid'));
      expect(session.capture.appliedTokens, isEmpty);
    });
  });

  test('renewal waits for renew_after_ms, at most 8 minutes and at most 9/10 of the remaining permit time', () {
    fakeAsync((async) {
      final session = _Session(async)..approve(renewAfterMs: 60000);
      session.elapse(59999);
      expect(session.socket.sent, hasLength(1));
      session.elapse(1);
      expect(session.socket.sent.last, {
        'type': 'engine.renew',
        'version': 1,
        'access_token': 'access-2',
        'engine': {'native_instance_id': 'instance-conversation', 'nonce': 'nonce-2', 'sequence': 2},
      });

      session.approve(renewAfterMs: 3600000);
      expect(session.capture.appliedTokens, ['permit-1', 'permit-2']);
      session.elapse(479999);
      expect(session.socket.sent, hasLength(2));
      session.elapse(1);
      expect(session.socket.sent, hasLength(3));

      session.capture.remainingMs = 1000;
      session.approve(renewAfterMs: 60000);
      session.elapse(899);
      expect(session.socket.sent, hasLength(3));
      session.elapse(1);
      expect(session.socket.sent, hasLength(4));
      expect(session.errors, isEmpty);
      session.controller.dispose();
    });
  });

  test('engine.denied before the first approval rejects ready with the server code', () {
    fakeAsync((async) {
      final session = _Session(async)..answer('engine.denied', {'code': 'engine_access_revoked', 'retryable': true});
      expect(session.readyError, _hasCode('engine_access_revoked'));
      expect(session.capture.invalidations, 1);
      expect(session.errors, isEmpty);
    });
  });

  test('after approval a retryable denial retries one second later, and a final denial calls onError', () {
    fakeAsync((async) {
      final session = _Session(async)..approve(renewAfterMs: 60000);
      session.elapse(60000);
      session.answer('engine.denied', {'code': 'engine_busy', 'retryable': true});
      session.elapse(999);
      expect(session.socket.sent, hasLength(2));
      session.elapse(1);
      expect(session.socket.sent.last['type'], 'engine.renew');
      expect(session.socket.sent.last['engine']['sequence'], 3);
      expect(session.errors, isEmpty);

      session.answer('engine.denied', {'code': 'engine_access_revoked', 'retryable': false});
      expect(session.errors.single, _hasCode('engine_access_revoked'));
      expect(session.capture.invalidations, 1);
    });
  });

  test('a response timeout rejects ready before the first approval', () {
    fakeAsync((async) {
      final session = _Session(async, requestTimeout: const Duration(seconds: 3));
      session.elapse(2999);
      expect(session.readyError, isNull);
      session.elapse(1);
      expect(session.readyError, _hasCode('engine_authorization_timeout'));
      expect(session.capture.invalidations, 1);
    });
  });

  test('a response timeout after approval retries the renewal', () {
    fakeAsync((async) {
      final session = _Session(async, requestTimeout: const Duration(seconds: 3))..approve(renewAfterMs: 60000);
      session.elapse(60000 + 3000 + 999);
      expect(session.socket.sent, hasLength(2));
      session.elapse(1);
      expect(session.socket.sent, hasLength(3));
      expect(session.errors, isEmpty);
      session.controller.dispose();
    });
  });

  test('an answer with another sequence rejects ready', () {
    fakeAsync((async) {
      final session = _Session(async);
      session.socket.receive({'type': 'engine.authorized', 'version': 1, 'sequence': 2, 'token': 'permit', 'renew_after_ms': 60000});
      async.flushMicrotasks();
      expect(session.readyError, _hasCode('engine_authorization_response_mismatch'));
      expect(session.capture.appliedTokens, isEmpty);
    });
  });

  test('an approved capture ignores the late answer to an older request', () {
    fakeAsync((async) {
      final session = _Session(async)..approve();
      session.socket.receive({'type': 'engine.renewed', 'version': 1, 'sequence': 1, 'token': 'late', 'renew_after_ms': 60000});
      async.flushMicrotasks();
      expect(session.capture.appliedTokens, ['permit-1']);
      expect(session.errors, isEmpty);
      expect(session.capture.invalidations, 0);
      session.controller.dispose();
    });
  });

  test('dispose invalidates the native permit and stops renewal', () {
    fakeAsync((async) {
      final session = _Session(async)..approve(renewAfterMs: 60000);
      session.controller.dispose();
      expect(session.capture.invalidations, 1);
      session.elapse(600000);
      expect(session.socket.sent, hasLength(1));
      expect(session.errors, isEmpty);
    });
  });

  test('dispose before the first approval rejects ready', () {
    fakeAsync((async) {
      final session = _Session(async);
      session.controller.dispose();
      async.flushMicrotasks();
      expect(session.readyError, _hasCode('engine_authorization_disposed'));
      expect(session.capture.invalidations, 1);
    });
  });

  test('a socket that closes after approval calls onError', () {
    fakeAsync((async) {
      final session = _Session(async)..approve();
      session.socket.close();
      async.flushMicrotasks();
      expect(session.errors.single, _hasCode('engine_authorization_connection_closed'));
      expect(session.capture.invalidations, 1);
    });
  });

  test('a socket that is not open fails ready, without an unhandled error while nobody listens', () {
    fakeAsync((async) {
      final capture = _Capture();
      final controller = attachEngineAuthorization(_Socket()..isOpen = false, capture,
          conversationId: 'conversation', getAccessToken: () async => 'access');
      // An unhandled error would fail this test here.
      async.flushMicrotasks();
      expect(controller.ready, throwsA(_hasCode('engine_authorization_connection_closed')));
      async.flushMicrotasks();
      expect(capture.sequence, 0);
    });
  });
}
