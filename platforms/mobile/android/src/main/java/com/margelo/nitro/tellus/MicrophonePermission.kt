package com.margelo.nitro.tellus

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.common.LifecycleState
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

private val pendingPermission = AtomicReference<Any?>(null)

internal fun requireForegroundActivity(context: ReactApplicationContext): Activity {
  val activity = context.currentActivity
  check(activity != null && !activity.isFinishing && !activity.isDestroyed && context.lifecycleState == LifecycleState.RESUMED) {
    "capture_start_requires_foreground_activity"
  }
  return activity
}

/** UI 결과 또는 Activity 종료까지 요청을 소유한다. timeout은 캡처를 시작하지 않는다. */
internal fun requestMicrophonePermission(context: ReactApplicationContext) {
  check(Looper.myLooper() != Looper.getMainLooper()) { "permission_request_requires_worker_thread" }
  if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return
  val ticket = Any()
  check(pendingPermission.compareAndSet(null, ticket)) { "microphone_permission_request_already_active" }
  val ready = CountDownLatch(1)
  val completed = AtomicBoolean(false)
  var failure: Exception? = null
  lateinit var lifecycle: LifecycleEventListener
  val finish: (Exception?) -> Unit = { error ->
    if (completed.compareAndSet(false, true)) {
      failure = error
      pendingPermission.compareAndSet(ticket, null)
      context.removeLifecycleEventListener(lifecycle)
      ready.countDown()
    }
  }
  lifecycle = object : LifecycleEventListener {
    override fun onHostResume() = Unit
    override fun onHostPause() = Unit
    override fun onHostDestroy() = finish(IllegalStateException("permission_activity_destroyed"))
  }
  context.addLifecycleEventListener(lifecycle)
  val queued = Handler(Looper.getMainLooper()).post {
    try {
      if (!completed.get()) {
        val activity = requireForegroundActivity(context) as? PermissionAwareActivity
        checkNotNull(activity) { "permission_aware_activity_required" }
        activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 16442, PermissionListener { code, _, _ ->
          if (code != 16442) false else { finish(null); true }
        })
      }
    } catch (error: Exception) { finish(error) }
  }
  if (!queued) finish(IllegalStateException("permission_ui_unavailable"))
  check(ready.await(60, TimeUnit.SECONDS)) { "microphone_permission_request_timeout" }
  failure?.let { throw it }
  check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { "microphone_permission_required" }
}
