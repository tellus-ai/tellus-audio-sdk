#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import <AudioToolbox/AudioToolbox.h>
#import <mach/mach_time.h>
#include "AudioDevice.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <condition_variable>
#include <fstream>
#include <mutex>
#include <stdexcept>

namespace margelo::nitro::tellus {
namespace {
std::atomic<bool> captureInUse{false};

// AVAudioEngine의 설정과 notification 수명은 UIKit main queue에서 직렬 관리한다.
void onMain(std::function<void()> operation) {
  __block std::exception_ptr error;
  auto run = ^{
    @try { try { operation(); } catch (...) { error = std::current_exception(); } }
    @catch (NSException* exception) {
      error = std::make_exception_ptr(std::runtime_error(exception.reason.UTF8String ?: "audio_engine_exception"));
    }
  };
  if ([NSThread isMainThread]) run();
  else dispatch_sync(dispatch_get_main_queue(), run);
  if (error) std::rethrow_exception(error);
}
void check(NSError* error) {
  if (error) throw std::runtime_error([[error localizedDescription] UTF8String]);
}
struct PlaybackProgress {
  std::mutex mutex;
  std::condition_variable changed;
  size_t pending = 0;
};

class IOSAudioDevice final : public AudioDevice {
public:
  IOSAudioDevice(std::function<void(const float*, size_t, uint32_t, int64_t)> capture,
                 std::function<void(const float*, size_t, uint32_t)> render,
                 std::function<void(const std::string&)> error)
      : _capture(std::move(capture)), _render(std::move(render)), _error(std::move(error)) {}
  ~IOSAudioDevice() override {
    try { stopCapture(); cancelPlayback(); } catch (...) {}
  }

  void requestCapturePermission() override {
      auto permitted = std::make_shared<std::atomic<bool>>(false);
      dispatch_semaphore_t answered = dispatch_semaphore_create(0);
      // https://developer.apple.com/documentation/avfaudio/avaudioapplication/requestrecordpermission(completionhandler:)
      onMain([&] {
        auto completion = ^(BOOL granted) { permitted->store(granted); dispatch_semaphore_signal(answered); };
        if (@available(iOS 17.0, *)) [AVAudioApplication requestRecordPermissionWithCompletionHandler:completion];
        else [[AVAudioSession sharedInstance] requestRecordPermission:completion];
      });
      if (dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC)) != 0 || !permitted->load()) {
        throw std::runtime_error("microphone_permission_required");
      }
  }

  void startCapture(uint32_t preferredRate) override {
    if (captureInUse.exchange(true)) throw std::runtime_error("microphone_already_running");
    _ownsCapture = true;
    try {
      onMain([&] {
        if ([UIApplication sharedApplication].applicationState != UIApplicationStateActive) {
          throw std::runtime_error("microphone_requires_foreground");
        }
        NSError* error = nil;
        AVAudioSession* session = [AVAudioSession sharedInstance];
        [session setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeMeasurement
                    options:AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetoothHFP error:&error];
        check(error);
        [session setPreferredSampleRate:preferredRate error:&error]; check(error);
        [session setPreferredIOBufferDuration:0.01 error:&error]; check(error);
        [session setActive:YES error:&error]; check(error);
        _engine = [[AVAudioEngine alloc] init];
        // main mixer 첫 접근은 output node도 연결하므로 I/O 시작 전에 graph를 준비한다.
        // https://developer.apple.com/documentation/avfaudio/avaudioengine/mainmixernode
        (void)_engine.mainMixerNode;
        AVAudioFormat* format = [_engine.inputNode outputFormatForBus:0];
        if (format.commonFormat != AVAudioPCMFormatFloat32 || format.interleaved || format.channelCount == 0 ||
            format.sampleRate < 8000 || format.sampleRate > 192000 || fmod(format.sampleRate, 50) != 0) {
          throw std::runtime_error("unsupported_microphone_format");
        }
        const auto rate = static_cast<uint32_t>(format.sampleRate);
        const auto host = mach_absolute_time();
        mach_timebase_info_data_t timebase;
        mach_timebase_info(&timebase);
        const int64_t wall = static_cast<int64_t>([[NSDate date] timeIntervalSince1970] * 1000);
        _running = true;
        // sink는 tap의 100ms 버퍼와 달리 실제 I/O frameCount를 전달한다. 첫 마이크 채널을 mono로 복사한다.
        // https://developer.apple.com/documentation/avfaudio/avaudiosinknode
        _sink = [[AVAudioSinkNode alloc] initWithReceiverBlock:^OSStatus(
            const AudioTimeStamp* timestamp, AVAudioFrameCount frames, const AudioBufferList* data) {
          if (_running && frames > 0 && data->mNumberBuffers > 0 && data->mBuffers[0].mData) {
            if (!(timestamp->mFlags & kAudioTimeStampHostTimeValid) || timestamp->mHostTime < host) return kAudio_ParamError;
            const auto elapsed = static_cast<unsigned __int128>(timestamp->mHostTime - host) * timebase.numer / timebase.denom;
            _capture(static_cast<const float*>(data->mBuffers[0].mData), frames, rate,
                     wall + static_cast<int64_t>(elapsed / 1000000));
          }
          return noErr;
        }];
        [_engine attachNode:_sink];
        [_engine connect:_engine.inputNode to:_sink format:format];
        [_engine startAndReturnError:&error]; check(error);
        observeSession();
      });
    } catch (...) { stopCapture(); throw; }
  }

  void stopCapture() override {
    _running = false;
    onMain([&] {
      for (id observer in _observers) [[NSNotificationCenter defaultCenter] removeObserver:observer];
      _observers = nil;
      [_player stop];
      [_engine stop];
      if (_sink) { [_engine disconnectNodeOutput:_engine.inputNode]; [_engine detachNode:_sink]; }
      _sink = nil; _player = nil; _engine = nil;
      if (_ownsCapture) {
        [[AVAudioSession sharedInstance] setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
        _ownsCapture = false;
        captureInUse = false;
      }
    });
  }

  void play(const float* samples, size_t count, uint32_t rate, const std::function<bool()>& cancelled) override {
    if (count == 0) return;
    auto progress = std::make_shared<PlaybackProgress>();
    {
      std::lock_guard<std::mutex> lock(_playbackMutex);
      _progress = progress;
    }
    onMain([&] {
      if (cancelled()) throw std::runtime_error("playback_cancelled");
      if (!_engine.isRunning) throw std::runtime_error("capture_not_running");
      if (_player) { [_player stop]; [_engine detachNode:_player]; }
      _player = [[AVAudioPlayerNode alloc] init];
      [_engine attachNode:_player];
      [_engine connect:_player to:_engine.mainMixerNode
                format:[[AVAudioFormat alloc] initStandardFormatWithSampleRate:rate channels:1]];
      [_player play];
    });
    try {
      for (size_t offset = 0; offset < count;) {
        {
          std::unique_lock<std::mutex> lock(progress->mutex);
          if (!progress->changed.wait_for(lock, std::chrono::seconds(2), [&] { return progress->pending < 3 || cancelled(); })) {
            throw std::runtime_error("playback_timeout");
          }
          if (cancelled()) throw std::runtime_error("playback_cancelled");
          ++progress->pending;
        }
        const size_t length = std::min<size_t>(rate / 50, count - offset);
        _render(samples + offset, length, rate);
        onMain([&] {
          if (cancelled()) throw std::runtime_error("playback_cancelled");
          AVAudioFormat* format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:rate channels:1];
          AVAudioPCMBuffer* buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:static_cast<AVAudioFrameCount>(length)];
          buffer.frameLength = static_cast<AVAudioFrameCount>(length);
          memcpy(buffer.floatChannelData[0], samples + offset, length * sizeof(float));
          [_player scheduleBuffer:buffer completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack completionHandler:^(AVAudioPlayerNodeCompletionCallbackType) {
            std::lock_guard<std::mutex> lock(progress->mutex);
            --progress->pending;
            progress->changed.notify_all();
          }];
        });
        offset += length;
      }
      std::unique_lock<std::mutex> lock(progress->mutex);
      if (!progress->changed.wait_for(lock, std::chrono::seconds(5), [&] { return progress->pending == 0 || cancelled(); })) {
        throw std::runtime_error("playback_timeout");
      }
      if (cancelled()) throw std::runtime_error("playback_cancelled");
    } catch (...) { cancelPlayback(); throw; }
  }

  void cancelPlayback() override {
    onMain([&] { [_player stop]; });
    std::lock_guard<std::mutex> lock(_playbackMutex);
    if (_progress) _progress->changed.notify_all();
  }

  DecodedAudio decodeAudio(const std::vector<uint8_t>& encoded, const std::function<bool()>& cancelled) override {
    @autoreleasepool {
      NSURL* url = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:[NSUUID UUID].UUIDString]];
      struct TemporaryFile {
        NSURL* url;
        ~TemporaryFile() { [[NSFileManager defaultManager] removeItemAtURL:url error:nil]; }
      } temporary{url};
      if (cancelled()) throw std::runtime_error("playback_cancelled");
      NSError* error = nil;
      NSData* bytes = [NSData dataWithBytes:encoded.data() length:encoded.size()];
      [bytes writeToURL:url options:NSDataWritingAtomic error:&error]; check(error);
      // OS 디코더의 Float32 출력을 mono로 합친다. 전체 출력은 PCM playback과 같은 16MiB로 제한한다.
      // https://developer.apple.com/documentation/avfaudio/avaudiofile
      AVAudioFile* file = [[AVAudioFile alloc] initForReading:url commonFormat:AVAudioPCMFormatFloat32 interleaved:NO error:&error];
      check(error);
      AVAudioFormat* format = file.processingFormat;
      if (!file || file.length <= 0 || file.length > 4 * 1024 * 1024 || format.channelCount == 0 || format.channelCount > 8 ||
          format.sampleRate < 8000 || format.sampleRate > 192000 || fmod(format.sampleRate, 50) != 0) {
        throw std::runtime_error("unsupported_encoded_audio");
      }
      DecodedAudio output{{}, static_cast<uint32_t>(format.sampleRate)};
      output.samples.reserve(static_cast<size_t>(file.length));
      AVAudioPCMBuffer* buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:4096];
      while (file.framePosition < file.length) {
        if (cancelled()) throw std::runtime_error("playback_cancelled");
        [file readIntoBuffer:buffer error:&error]; check(error);
        if (buffer.frameLength == 0) throw std::runtime_error("encoded_audio_truncated");
        for (AVAudioFrameCount index = 0; index < buffer.frameLength; ++index) {
          float sample = 0;
          for (AVAudioChannelCount channel = 0; channel < format.channelCount; ++channel) sample += buffer.floatChannelData[channel][index] / format.channelCount;
          if (!std::isfinite(sample) || sample < -1 || sample > 1) throw std::runtime_error("invalid_playback_pcm");
          output.samples.push_back(sample);
        }
        if (output.samples.size() > 4 * 1024 * 1024) throw std::runtime_error("encoded_audio_too_long");
      }
      if (cancelled()) throw std::runtime_error("playback_cancelled");
      return output;
    }
  }

private:
  void observeSession() {
    _observers = [NSMutableArray new];
    auto observe = [&](NSNotificationName name, std::function<bool(NSNotification*)> applies, const std::string& code) {
      id observer = [[NSNotificationCenter defaultCenter] addObserverForName:name object:nil
          queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification* notification) {
        if (_running && applies(notification)) { _running = false; _error(code); }
      }];
      [_observers addObject:observer];
    };
    observe(AVAudioSessionInterruptionNotification, [](NSNotification* n) {
      return [n.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan;
    }, "audio_interrupted");
    observe(AVAudioSessionRouteChangeNotification, [](NSNotification* n) {
      auto reason = [n.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue];
      return reason == AVAudioSessionRouteChangeReasonNewDeviceAvailable || reason == AVAudioSessionRouteChangeReasonOldDeviceUnavailable;
    }, "audio_route_changed");
    observe(AVAudioSessionMediaServicesWereResetNotification, [](NSNotification*) { return true; }, "audio_services_reset");
    observe(UIApplicationDidEnterBackgroundNotification, [](NSNotification*) {
      return ![[NSBundle mainBundle].infoDictionary[@"UIBackgroundModes"] containsObject:@"audio"];
    }, "audio_backgrounded");
  }

  std::function<void(const float*, size_t, uint32_t, int64_t)> _capture;
  std::function<void(const float*, size_t, uint32_t)> _render;
  std::function<void(const std::string&)> _error;
  std::atomic<bool> _running{false};
  bool _ownsCapture = false;
  AVAudioEngine* _engine = nil;
  AVAudioSinkNode* _sink = nil;
  AVAudioPlayerNode* _player = nil;
  NSMutableArray* _observers = nil;
  std::mutex _playbackMutex;
  std::shared_ptr<PlaybackProgress> _progress;
};
} // namespace

std::unique_ptr<AudioDevice> createAudioDevice(
    std::function<void(const float*, size_t, uint32_t, int64_t)> capture,
    std::function<void(const float*, size_t, uint32_t)> render,
    std::function<void(const std::string&)> error) {
  return std::make_unique<IOSAudioDevice>(std::move(capture), std::move(render), std::move(error));
}

std::vector<uint8_t> readEncryptedModel(const std::string& path) {
  @autoreleasepool {
    NSURL* url = nil;
    NSString* name = [NSString stringWithUTF8String:path.c_str()];
    if ([name hasPrefix:@"file://"]) url = [NSURL URLWithString:name];
    else if ([name hasPrefix:@"/"]) url = [NSURL fileURLWithPath:name];
    else {
      NSURL* resourceURL = [[NSBundle mainBundle] URLForResource:@"TellusAudioSdkModels" withExtension:@"bundle"];
      if (!resourceURL) throw std::runtime_error("encrypted_model_not_found");
      NSBundle* resources = [NSBundle bundleWithURL:resourceURL];
      url = [resources URLForResource:name withExtension:nil];
    }
    if (!url.isFileURL) throw std::runtime_error("encrypted_model_not_found");
    std::ifstream file(url.fileSystemRepresentation, std::ios::binary | std::ios::ate);
    const auto length = file.tellg();
    if (!file || length <= 0 || length > 64 * 1024 * 1024 + 171) throw std::runtime_error("encrypted_model_size_invalid");
    std::vector<uint8_t> bytes(static_cast<size_t>(length));
    file.seekg(0);
    if (!file.read(reinterpret_cast<char*>(bytes.data()), length)) throw std::runtime_error("encrypted_model_read_failed");
    return bytes;
  }
}
} // namespace margelo::nitro::tellus
