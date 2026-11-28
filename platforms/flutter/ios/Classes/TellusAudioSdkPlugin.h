#import <Flutter/Flutter.h>

// The plugin class that pubspec.yaml names. It registers no channel: Dart calls the C functions of
// native/tellus_flutter_capture.h directly with dart:ffi.
@interface TellusAudioSdkPlugin : NSObject <FlutterPlugin>
@end
