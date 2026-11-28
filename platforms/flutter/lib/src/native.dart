import 'dart:async';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'types.dart';

/// Receives one chunk: its payload, the engine's metadata JSON, and the two values to pass to
/// [NativeCapture.canDeliver].
typedef NativeChunkHandler = void Function(Uint8List payload, String metadataJson, int epoch, int generation);
typedef NativeErrorHandler = void Function(String code, String? message);

/// The native side of one capture: the functions of `native/tellus_flutter_capture.h`.
abstract interface class NativeCapture {
  /// Runs one method from the table of `tellus_flutter_capture_call`. Completes with the method's
  /// result, or fails with a [TellusAudioException] that carries the native error code.
  Future<String?> invoke(String method, {String? argument, double number = 0, Uint8List? bytes});
  bool canDeliver(int epoch, int generation);
  void acknowledgeChunk();
  void invalidateAuthorization();

  /// Frees the native capture. Allowed only after the reply to `close`; nothing may be called afterwards.
  void destroy();
}

/// Creates the native side of a capture. Tests replace it with a fake.
NativeCapture Function(NativeChunkHandler onChunk, NativeErrorHandler onError) createNativeCapture = _FfiCapture.new;

typedef _Reply = Void Function(Int64 requestId, Pointer<Utf8> errorCode, Pointer<Utf8> errorMessage, Pointer<Utf8> result);
typedef _Chunk = Void Function(
    Int64 captureId, Pointer<Uint8> payload, Uint64 payloadLength, Pointer<Utf8> metadataJson, Uint64 epoch, Uint64 generation);
typedef _Error = Void Function(Int64 captureId, Pointer<Utf8> errorCode, Pointer<Utf8> errorMessage);
typedef _PointerNative = Void Function(Pointer<Void> pointer);
typedef _PointerDart = void Function(Pointer<Void> pointer);

// Dart initializes a top-level variable on first use, so importing this file loads no library and
// looks up no symbol. The Dart VM that runs the unit tests has neither.
final _library = Platform.isAndroid ? DynamicLibrary.open('libtellus_audio_sdk_flutter.so') : DynamicLibrary.process();

final _create = _library.lookupFunction<
    Pointer<Void> Function(
        Int64, Pointer<NativeFunction<_Reply>>, Pointer<NativeFunction<_Chunk>>, Pointer<NativeFunction<_Error>>),
    Pointer<Void> Function(
        int, Pointer<NativeFunction<_Reply>>, Pointer<NativeFunction<_Chunk>>, Pointer<NativeFunction<_Error>>)>(
    'tellus_flutter_capture_create');
final _call = _library.lookupFunction<
    Void Function(Pointer<Void>, Int64, Pointer<Utf8>, Pointer<Utf8>, Double, Pointer<Uint8>, Uint64),
    void Function(Pointer<Void>, int, Pointer<Utf8>, Pointer<Utf8>, double, Pointer<Uint8>, int)>('tellus_flutter_capture_call');
final _canDeliver = _library.lookupFunction<Uint8 Function(Pointer<Void>, Uint64, Uint64), int Function(Pointer<Void>, int, int)>(
    'tellus_flutter_capture_can_deliver');
final _acknowledgeChunk = _library.lookupFunction<_PointerNative, _PointerDart>('tellus_flutter_capture_acknowledge_chunk');
final _invalidateAuthorization =
    _library.lookupFunction<_PointerNative, _PointerDart>('tellus_flutter_capture_invalidate_authorization');
final _destroy = _library.lookupFunction<_PointerNative, _PointerDart>('tellus_flutter_capture_destroy');
final _free = _library.lookupFunction<_PointerNative, _PointerDart>('tellus_flutter_free');

// One set of callbacks serves every capture of this isolate. Native calls them from its own threads
// and Dart runs them later on the isolate. They do not keep the isolate alive by themselves.
final _replyCallback = NativeCallable<_Reply>.listener(_handleReply)..keepIsolateAlive = false;
final _chunkCallback = NativeCallable<_Chunk>.listener(_handleChunk)..keepIsolateAlive = false;
final _errorCallback = NativeCallable<_Error>.listener(_handleError)..keepIsolateAlive = false;

final _replies = <int, Completer<String?>>{};
final _captures = <int, _FfiCapture>{};
// Capture IDs and request IDs both come from this counter.
var _nextId = 0;

// Every non-NULL pointer a callback receives belongs to Dart. It is copied and freed here, before
// anything else looks at it, so it is released even when its capture is already gone.
String? _takeString(Pointer<Utf8> pointer) {
  if (pointer == nullptr) return null;
  final value = pointer.toDartString();
  _free(pointer.cast());
  return value;
}

void _handleReply(int requestId, Pointer<Utf8> errorCode, Pointer<Utf8> errorMessage, Pointer<Utf8> result) {
  final code = _takeString(errorCode);
  final message = _takeString(errorMessage);
  final value = _takeString(result);
  final reply = _replies.remove(requestId);
  if (code == null) {
    reply?.complete(value);
  } else {
    reply?.completeError(TellusAudioException(code, engineMessage: message));
  }
}

void _handleChunk(int captureId, Pointer<Uint8> payload, int payloadLength, Pointer<Utf8> metadataJson, int epoch, int generation) {
  var bytes = Uint8List(0);
  if (payload != nullptr) {
    bytes = Uint8List.fromList(payload.asTypedList(payloadLength));
    _free(payload.cast());
  }
  final metadata = _takeString(metadataJson);
  _captures[captureId]?._onChunk(bytes, metadata ?? '', epoch, generation);
}

void _handleError(int captureId, Pointer<Utf8> errorCode, Pointer<Utf8> errorMessage) {
  final code = _takeString(errorCode);
  final message = _takeString(errorMessage);
  _captures[captureId]?._onError(code ?? '', message);
}

final class _FfiCapture implements NativeCapture {
  _FfiCapture(this._onChunk, this._onError) {
    _capture = _create(_id, _replyCallback.nativeFunction, _chunkCallback.nativeFunction, _errorCallback.nativeFunction);
    if (_capture == nullptr) throw const TellusAudioException('capture_create_failed');
    _captures[_id] = this;
  }

  final NativeChunkHandler _onChunk;
  final NativeErrorHandler _onError;
  final _id = _nextId++;
  late final Pointer<Void> _capture;

  @override
  Future<String?> invoke(String method, {String? argument, double number = 0, Uint8List? bytes}) {
    final requestId = _nextId++;
    final reply = Completer<String?>();
    _replies[requestId] = reply;
    // Native borrows these pointers only until the call returns.
    using((arena) {
      var nativeBytes = nullptr.cast<Uint8>();
      if (bytes != null) {
        nativeBytes = arena<Uint8>(bytes.length);
        nativeBytes.asTypedList(bytes.length).setAll(0, bytes);
      }
      _call(_capture, requestId, method.toNativeUtf8(allocator: arena), argument?.toNativeUtf8(allocator: arena) ?? nullptr,
          number, nativeBytes, bytes?.length ?? 0);
    });
    return reply.future;
  }

  @override
  bool canDeliver(int epoch, int generation) => _canDeliver(_capture, epoch, generation) != 0;

  @override
  void acknowledgeChunk() => _acknowledgeChunk(_capture);

  @override
  void invalidateAuthorization() => _invalidateAuthorization(_capture);

  @override
  void destroy() {
    // A callback that still arrives finds no capture and only frees its pointers.
    _captures.remove(_id);
    _destroy(_capture);
  }
}
