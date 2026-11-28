package ai.tellus.audio.flutter

import com.facebook.soloader.nativeloader.NativeLoader
import com.facebook.soloader.nativeloader.SystemDelegate
import com.margelo.nitro.FlutterApplicationContext
import com.margelo.nitro.NitroModules
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding

/** Loads the native library that Dart calls through dart:ffi and tracks the Flutter activity. It has no method channel. */
class TellusAudioSdkPlugin : FlutterPlugin, ActivityAware {
  private var activityBinding: ActivityPluginBinding? = null

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    // Every Flutter engine of the process attaches its own plugin instance. The first one prepares the process.
    if (NitroModules.applicationContext != null) return
    NitroModules.applicationContext = FlutterApplicationContext(binding.applicationContext)
    // fbjni's Java classes load libfbjni.so through NativeLoader, which fails until it has a delegate.
    // React Native sets one; a Flutter app has none.
    NativeLoader.initIfUninitialized(SystemDelegate())
    // JNI_OnLoad looks up the Kotlin audio classes and needs the app class loader, so the library is
    // loaded here, before Dart opens it.
    System.loadLibrary("tellus_audio_sdk_flutter")
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) = Unit

  override fun onAttachedToActivity(binding: ActivityPluginBinding) {
    activityBinding = binding
    NitroModules.applicationContext?.let { it.activityBindings += binding }
  }

  override fun onDetachedFromActivity() {
    val binding = activityBinding ?: return
    activityBinding = null
    NitroModules.applicationContext?.let { it.activityBindings -= binding }
  }

  override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)
  override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()
}
