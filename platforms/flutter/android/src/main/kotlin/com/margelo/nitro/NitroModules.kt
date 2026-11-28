package com.margelo.nitro

import android.content.Context
import android.content.ContextWrapper
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding

/**
 * Stands in for the NitroModules object of react-native-nitro-modules. The Kotlin sources shared with the
 * React Native package (platforms/mobile/android) read the application context from it, so with this
 * object they compile unchanged. TellusAudioSdkPlugin sets applicationContext.
 */
object NitroModules {
  @JvmStatic @Volatile var applicationContext: FlutterApplicationContext? = null
}

/** The application context, which also knows the Flutter activity as React Native's context knows its activity. */
class FlutterApplicationContext(base: Context) : ContextWrapper(base) {
  /** One binding per Flutter engine that is attached to an activity. Changed on the main thread only. */
  @Volatile var activityBindings: List<ActivityPluginBinding> = emptyList()

  /** The binding of the activity that was attached last. */
  val activityBinding: ActivityPluginBinding? get() = activityBindings.lastOrNull()
}
