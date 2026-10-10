package com.margelo.nitro.tellus

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRouting
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import androidx.annotation.Keep
import com.margelo.nitro.NitroModules
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** OS I/O만 소유한다. nativeSubmit은 PCM을 복사하고 Rust 작업 queue에 넘긴다. */
@Keep
class AndroidAudioDevice(@Volatile private var nativeHandle: Long) {
  private val context = checkNotNull(NitroModules.applicationContext) { "react_context_unavailable" }
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
  private val focusLock = Any()
  private var focusHeld = false
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
  @Volatile private var focusGeneration = 0L
  private val playback = AudioPlayback(::interrupt)
  private val captureLock = Any()
  @Volatile private var recorder: AudioRecord? = null
  private var reader: Thread? = null
  private var foreground: TellusMicrophoneService.Lease? = null
  private var notification: RecordingNotification? = null
  @Volatile private var capturing = false
  @Volatile private var playing = false

  fun requestCapturePermission() = requestMicrophonePermission(context)

  fun startCapture(rate: Int) {
    check(Looper.myLooper() != Looper.getMainLooper()) { "capture_start_requires_worker_thread" }
    check(recorder == null) { "capture_already_active" }
    check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { "microphone_permission_required" }
    if (foreground == null) {
      requireForegroundActivity(context)
      foreground = TellusMicrophoneService.acquire(context, notification, ::notificationAction) { interrupt("microphone_service_stopped") }
    }
    try {
      capturing = true
      foreground?.update(notification)
      acquireFocus()
      val minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT)
      check(minimum > 0) { "capture_format_unsupported" }
      val source = if (audioManager.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true") {
        MediaRecorder.AudioSource.UNPROCESSED
      } else MediaRecorder.AudioSource.VOICE_RECOGNITION
      val input = AudioRecord.Builder().setAudioSource(source)
        .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
          .setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build())
        .setBufferSizeInBytes(maxOf(minimum, rate / 50 * 4)).build()
      synchronized(captureLock) { recorder = input }
      var previousDevice = -1
      input.addOnRoutingChangedListener(AudioRouting.OnRoutingChangedListener {
        val current = it.routedDevice?.id ?: -1
        if (previousDevice != -1 && current != previousDevice && recorder === it && capturing) interrupt("capture_route_changed")
        previousDevice = current
      }, Handler(Looper.getMainLooper()))
      synchronized(captureLock) {
        check(capturing) { "capture_interrupted_during_start" }
        check(input.state == AudioRecord.STATE_INITIALIZED) { "capture_initialization_failed" }
        input.startRecording()
      }
      reader = Thread({ readCapture(input) }, "TellusCapture").also { it.start() }
    } catch (error: Exception) {
      stopCapture()
      throw error
    }
  }

  // AudioRecord는 ByteBuffer position/limit을 무시하고 실제 읽은 byte 수를 반환한다.
  // https://developer.android.com/reference/android/media/AudioRecord#read(java.nio.ByteBuffer,int,int)
  private fun readCapture(input: AudioRecord) {
    try {
      Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
      val rate = input.sampleRate
      val buffer = ByteBuffer.allocateDirect(rate / 50 * 4).order(ByteOrder.nativeOrder())
      val epoch = System.currentTimeMillis()
      var samplesRead = 0L
      var lastProgress = SystemClock.elapsedRealtime()
      while (capturing) {
        val bytes = input.read(buffer, buffer.capacity(), AudioRecord.READ_NON_BLOCKING)
        check(bytes >= 0) { "capture_read_failed:$bytes" }
        if (bytes > 0) {
          synchronized(this) {
            if (capturing && nativeHandle != 0L) nativeSubmit(nativeHandle, buffer, bytes / 4, rate, epoch + samplesRead * 1000 / rate)
          }
          samplesRead += bytes / 4
          lastProgress = SystemClock.elapsedRealtime()
        } else {
          check(SystemClock.elapsedRealtime() - lastProgress < 2000) { "capture_read_timeout" }
          Thread.sleep(2)
        }
      }
    } catch (error: Exception) {
      if (capturing) interrupt(error.message ?: "capture_read_failed")
    }
  }

  fun setRecordingNotification(title: String, contentText: String, pauseAction: Boolean, resumeAction: Boolean) {
    notification = RecordingNotification(title, contentText, pauseAction, resumeAction)
    foreground?.update(notification?.copy(paused = !capturing))
  }

  fun stopCapture() = endCapture(false)
  fun pauseCapture() = endCapture(notification != null)

  private fun endCapture(keepNotification: Boolean) {
    capturing = false
    val input = synchronized(captureLock) {
      recorder.also { if (it?.recordingState == AudioRecord.RECORDSTATE_RECORDING) it.stop() }
    }
    reader?.join()
    reader = null
    synchronized(captureLock) { input?.release(); recorder = null }
    val lease = foreground
    if (keepNotification) lease?.update(notification?.copy(paused = true))
    else { foreground = null; lease?.close() }
    releaseFocusIfIdle()
  }

  fun beginPlayback(rate: Int) {
    playing = true
    try {
      acquireFocus()
      playback.start(rate, attributes) { playing }
    }
    catch (error: Exception) { endPlayback(); throw error }
  }
  fun writePlayback(samples: ByteBuffer, bytes: Int): Int = playback.write(samples, bytes)
  fun awaitPlayback() = playback.awaitCompletion()
  fun cancelPlayback() { playing = false; playback.cancel(); releaseFocusIfIdle() }
  fun endPlayback() { playing = false; playback.close(); releaseFocusIfIdle() }

  fun close() {
    synchronized(this) { nativeHandle = 0 }
    stopCapture()
    cancelPlayback()
    endPlayback()
  }

  private fun interrupt(message: String) {
    capturing = false
    playing = false
    synchronized(captureLock) { recorder?.let { if (it.recordingState == AudioRecord.RECORDSTATE_RECORDING) it.stop() } }
    playback.cancel()
    synchronized(this) { if (nativeHandle != 0L) nativeError(nativeHandle, message) }
  }

  private fun acquireFocus() = synchronized(focusLock) {
    if (focusHeld) return@synchronized
    val generation = ++focusGeneration
    val listener = AudioManager.OnAudioFocusChangeListener {
      if (generation == focusGeneration && it != AudioManager.AUDIOFOCUS_GAIN) interrupt("audio_focus_lost")
    }
    focusListener = listener
    val granted = if (Build.VERSION.SDK_INT >= 26) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes)
        .setWillPauseWhenDucked(true).setOnAudioFocusChangeListener(listener, Handler(Looper.getMainLooper())).build()
      focusRequest = request
      audioManager.requestAudioFocus(request)
    } else audioManager.requestAudioFocus(listener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN)
    check(granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "audio_focus_unavailable" }
    focusHeld = true
  }

  private fun releaseFocusIfIdle() = synchronized(focusLock) {
    if (!focusHeld || capturing || playing) return@synchronized
    focusHeld = false
    focusGeneration++
    if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
    else focusListener?.let { audioManager.abandonAudioFocus(it) }
    focusRequest = null
    focusListener = null
  }

  private fun notificationAction(action: String) {
    try { synchronized(this) { if (nativeHandle != 0L) nativeNotificationAction(nativeHandle, action) } }
    catch (error: Exception) { interrupt(error.message ?: "notification_action_failed") }
  }

  private external fun nativeNotificationAction(handle: Long, action: String)
  private external fun nativeSubmit(handle: Long, samples: ByteBuffer, count: Int, rate: Int, timestampMs: Long)
  private external fun nativeError(handle: Long, message: String)

  companion object {
    /** 파일 또는 앱에 패키지된 암호화 컨테이너만 읽는다. 평문은 native에서 거부한다. */
    @JvmStatic fun readEncryptedModel(path: String): ByteArray {
      val app = checkNotNull(NitroModules.applicationContext) { "react_context_unavailable" }
      val input = if (path.startsWith("file://") || path.startsWith("/")) {
        File(path.removePrefix("file://")).inputStream()
      } else app.assets.open(if (path.startsWith("asset://")) path.removePrefix("asset://") else "tellus-audio-sdk/$path")
      return input.use {
        val output = ByteArrayOutputStream()
        val block = ByteArray(8192)
        while (true) {
          val count = it.read(block)
          if (count < 0) break
          check(output.size().toLong() + count <= 64L * 1024 * 1024 + 171) { "model_container_too_large" }
          output.write(block, 0, count)
        }
        output.toByteArray()
      }
    }
  }
}
