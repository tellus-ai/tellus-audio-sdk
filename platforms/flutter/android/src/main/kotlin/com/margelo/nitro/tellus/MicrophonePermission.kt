package com.margelo.nitro.tellus

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import com.margelo.nitro.FlutterApplicationContext
import io.flutter.plugin.common.PluginRegistry.RequestPermissionsResultListener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

// The Flutter version of platforms/mobile/android/.../MicrophonePermission.kt, which is tied to React Native.
// Same functions, behaviour and error strings. Flutter's activities (FlutterActivity, FlutterFragmentActivity)
// are LifecycleOwners, and that Lifecycle takes the place of React Native's host lifecycle.

private val pendingPermission = AtomicReference<Any?>(null)

private fun lifecycleOf(activity: Activity): Lifecycle? = (activity as? LifecycleOwner)?.lifecycle

internal fun requireForegroundActivity(context: FlutterApplicationContext): Activity {
  val activity = context.activityBinding?.activity
  check(activity != null && !activity.isFinishing && !activity.isDestroyed &&
      lifecycleOf(activity)?.currentState == Lifecycle.State.RESUMED) {
    "capture_start_requires_foreground_activity"
  }
  return activity
}

/** Owns the request until the UI result or the Activity ends. A timeout does not start capture. */
internal fun requestMicrophonePermission(context: FlutterApplicationContext): Boolean {
  check(Looper.myLooper() != Looper.getMainLooper()) { "permission_request_requires_worker_thread" }
  if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return true
  val ticket = Any()
  check(pendingPermission.compareAndSet(null, ticket)) { "microphone_permission_request_already_active" }
  val ready = CountDownLatch(1)
  val completed = AtomicBoolean(false)
  var failure: Exception? = null
  var unregister = {}
  val finish: (Exception?) -> Unit = { error ->
    if (completed.compareAndSet(false, true)) {
      failure = error
      pendingPermission.compareAndSet(ticket, null)
      unregister()
      ready.countDown()
    }
  }
  val main = Handler(Looper.getMainLooper())
  // Lifecycle observers and Flutter's listeners may only be changed on the main thread.
  val queued = main.post {
    try {
      val activity = requireForegroundActivity(context)
      val binding = checkNotNull(context.activityBinding)
      val lifecycle = checkNotNull(lifecycleOf(activity))
      var answered = false
      // Android delivers the result before onResume. Capture start requires the resumed Activity,
      // so the request completes on resume, as it does in React Native.
      val observer = LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_DESTROY) finish(IllegalStateException("permission_activity_destroyed"))
        else if (event == Lifecycle.Event.ON_RESUME && answered) finish(null)
      }
      val listener = RequestPermissionsResultListener { code, _, _ ->
        if (code != 16442) false else {
          answered = true
          if (lifecycle.currentState == Lifecycle.State.RESUMED) finish(null)
          true
        }
      }
      unregister = {
        lifecycle.removeObserver(observer)
        // Flutter iterates its listeners while it delivers a result, so the listener is removed after that.
        main.post { binding.removeRequestPermissionsResultListener(listener) }
      }
      lifecycle.addObserver(observer)
      binding.addRequestPermissionsResultListener(listener)
      activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 16442)
    } catch (error: Exception) { finish(error) }
  }
  if (!queued) finish(IllegalStateException("permission_ui_unavailable"))
  check(ready.await(60, TimeUnit.SECONDS)) { "microphone_permission_request_timeout" }
  failure?.let { throw it }
  return context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
}
