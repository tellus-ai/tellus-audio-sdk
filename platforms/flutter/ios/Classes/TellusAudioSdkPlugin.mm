#import "TellusAudioSdkPlugin.h"

#include "native/tellus_flutter_capture.h"

// Dart finds the C functions by name with DynamicLibrary.process(), so no code in the app refers to
// them, and the linker takes an object file out of a static framework only when something refers to
// it. The app's GeneratedPluginRegistrant refers to this class, and this table refers to the functions.
__attribute__((used)) static void* const dartFunctions[] = {
  (void*)&tellus_flutter_capture_create,
  (void*)&tellus_flutter_capture_call,
  (void*)&tellus_flutter_capture_can_deliver,
  (void*)&tellus_flutter_capture_acknowledge_chunk,
  (void*)&tellus_flutter_capture_invalidate_authorization,
  (void*)&tellus_flutter_capture_destroy,
  (void*)&tellus_flutter_free,
};

@implementation TellusAudioSdkPlugin

+ (void)registerWithRegistrar:(NSObject<FlutterPluginRegistrar>*)registrar {
}

@end
