package com.margelo.nitro.tellus

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Binder
import android.os.Build
import android.os.IBinder
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal data class RecordingNotification(
  val title: String, val contentText: String, val pauseAction: Boolean, val resumeAction: Boolean, val paused: Boolean = false
) {
  val action: String? get() = if (paused) { if (resumeAction) "resume" else null } else { if (pauseAction) "pause" else null }
}

/** 명시적으로 시작한 캡처를 background에서도 유지한다. 재시작하지 않는다. */
class TellusMicrophoneService : Service() {
  inner class LocalBinder : Binder() { val service get() = this@TellusMicrophoneService }
  private var request: Request? = null
  private var stopped = false
  private val actionIntents = mutableMapOf<String, PendingIntent>()
  val destroyed = CountDownLatch(1)
  @Volatile var startupError: RuntimeException? = null

  override fun onCreate() {
    super.onCreate()
    val active = claimed.get()
    request = active
    if (active == null || !active.active.get()) { stopSelf(); return }
    try {
      val manager = getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= 26) {
        manager.createNotificationChannel(NotificationChannel("tellus-microphone", "Microphone", NotificationManager.IMPORTANCE_LOW))
      }
      val notification = synchronized(this) { buildNotification(active) }
      if (Build.VERSION.SDK_INT >= 30) startForeground(16441, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      else startForeground(16441, notification)
    } catch (error: RuntimeException) {
      startupError = error
      stopSelf()
    }
  }

  private fun buildNotification(active: Request): Notification {
    val config = active.notification
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "tellus-microphone") else Notification.Builder(this)
    builder.setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(config?.title ?: applicationInfo.loadLabel(packageManager))
      .setContentText(config?.contentText ?: "Microphone capture is active").setOngoing(true)
    config?.action?.let { action ->
      val pending = actionIntents.getOrPut(action) {
        val intent = Intent(this, TellusMicrophoneService::class.java).setAction(active.actionId(action))
        PendingIntent.getService(this, 16442, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      }
      val icon = if (action == "pause") android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
      builder.addAction(Notification.Action.Builder(Icon.createWithResource(this, icon), if (action == "pause") "Pause" else "Resume", pending).build())
    }
    return builder.build()
  }

  private fun updateNotification(active: Request, notification: RecordingNotification?) = synchronized(this) {
    check(request === active && active.active.get() && !stopped) { "microphone_service_session_unavailable" }
    active.notification = notification
    getSystemService(NotificationManager::class.java).notify(16441, buildNotification(active))
  }

  override fun onBind(intent: Intent): IBinder = LocalBinder()
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // lease monitor는 stop 이후 도착한 OS action을 차단한다. action은 앱 callback만 호출한다.
    synchronized(this) {
      val active = request
      val action = active?.notification?.action
      if (active != null && active.active.get() && active.ready && !stopped && action != null && intent?.action == active.actionId(action)) {
        active.onAction(action)
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    try {
      synchronized(this) {
        stopped = true
        actionIntents.values.forEach { it.cancel() }
        actionIntents.clear()
        val active = request
        if (active != null && active.active.get() && active.ready) active.onStopped()
      }
    } finally {
      stopForeground(STOP_FOREGROUND_REMOVE)
      destroyed.countDown()
      super.onDestroy()
    }
  }

  internal class Request(
    @Volatile var notification: RecordingNotification?, val onAction: (String) -> Unit, val onStopped: () -> Unit
  ) {
    val active = AtomicBoolean(true)
    var ready = false
    private val id = UUID.randomUUID().toString()
    fun actionId(action: String) = "com.margelo.nitro.tellus.$id.$action"
  }

  internal class Lease(
    private val context: Context, private val service: TellusMicrophoneService, private val request: Request,
    private val connection: ServiceConnection, private val intent: Intent
  ) : Closeable {
    fun update(notification: RecordingNotification?) = service.updateNotification(request, notification)
    override fun close() {
      synchronized(service) {
        if (!request.active.compareAndSet(true, false)) return
        service.actionIntents.values.forEach { it.cancel() }
        service.actionIntents.clear()
      }
      try {
        context.unbindService(connection)
        context.stopService(intent)
        check(service.destroyed.await(5, TimeUnit.SECONDS)) { "microphone_service_stop_timeout" }
      } finally { claimed.compareAndSet(request, null) }
    }
  }

  companion object {
    private val claimed = AtomicReference<Request?>(null)

    /** FGS가 생성된 뒤 반환한다. main thread에서는 호출하지 않는다. */
    internal fun acquire(context: Context, notification: RecordingNotification?, onAction: (String) -> Unit, onStopped: () -> Unit): Lease {
      val request = Request(notification, onAction, onStopped)
      check(claimed.compareAndSet(null, request)) { "microphone_capture_already_active" }
      val intent = Intent(context, TellusMicrophoneService::class.java)
      val ready = CountDownLatch(1)
      var service: TellusMicrophoneService? = null
      val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
          service = (binder as LocalBinder).service
          ready.countDown()
        }
        override fun onServiceDisconnected(name: ComponentName) {
          service?.let { synchronized(it) { if (request.active.get() && request.ready) onStopped() } }
        }
      }
      var bound = false
      try {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
        check(bound && ready.await(5, TimeUnit.SECONDS)) { "microphone_service_start_timeout" }
        val active = checkNotNull(service)
        active.startupError?.let { throw it }
        synchronized(active) {
          check(active.request === request && !active.stopped) { "microphone_service_session_unavailable" }
          request.ready = true
        }
        return Lease(context, active, request, connection, intent)
      } catch (error: Exception) {
        request.active.set(false)
        if (bound) context.unbindService(connection)
        context.stopService(intent)
        claimed.compareAndSet(request, null)
        throw error
      }
    }
  }
}
