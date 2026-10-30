package com.margelo.nitro.tellus

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
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
import org.json.JSONArray
import org.json.JSONObject

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
  private var micDeviceId: String? = null
  private var playbackDeviceId: String? = null
  @Volatile private var microphoneStatus: JSONObject? = null
  @Volatile private var playbackStatus: JSONObject? = null
  private val playback = AudioPlayback(::interrupt) { code, actual ->
    updateDeviceStatus("playback", code, playbackDeviceId, actual)
  }
  private val captureLock = Any()
  @Volatile private var recorder: AudioRecord? = null
  private var reader: Thread? = null
  private var foreground: TellusMicrophoneService.Lease? = null
  private var notification: RecordingNotification? = null
  @Volatile private var capturing = false
  @Volatile private var playing = false

  fun requestCapturePermission() {
    if (!requestMicrophonePermission(context)) {
      updateDeviceStatus("microphone", "permission_denied", micDeviceId)
      error("microphone_permission_required")
    }
  }

  fun configureDevices(microphone: String, output: String, iosOutputRoute: String) {
    check(!capturing && !playing) { "audio_devices_already_active" }
    if (iosOutputRoute.isNotEmpty()) {
      updateDeviceStatus("playback", "unsupported", null)
      error("ios_output_route_unsupported")
    }
    microphoneStatus = null
    playbackStatus = null
    micDeviceId = microphone.takeIf { it.isNotEmpty() }
    playbackDeviceId = output.takeIf { it.isNotEmpty() }
    micDeviceId?.let { resolveDevice(it, "microphone"); updateDeviceStatus("microphone", "pending", it) }
    playbackDeviceId?.let { resolveDevice(it, "playback"); updateDeviceStatus("playback", "pending", it) }
  }

  fun listAudioDevices(source: String): String {
    require(source in listOf("microphone", "system_audio", "playback")) { "audio_device_source_invalid" }
    val devices = JSONArray()
    val status = JSONObject().put("source", source).put("code", if (source == "system_audio") "unsupported" else "ready")
    if (source != "system_audio") {
      val direction = if (source == "microphone") AudioManager.GET_DEVICES_INPUTS else AudioManager.GET_DEVICES_OUTPUTS
      try {
        audioManager.getDevices(direction).forEach {
          devices.put(JSONObject().put("id", it.id.toString()).put("label", it.productName.toString()))
        }
      } catch (error: SecurityException) {
        status.put("code", "permission_denied")
      }
    }
    return JSONObject().put("status", status).put("devices", devices).toString()
  }

  fun getAudioDeviceStatus(): String = JSONArray().apply {
    microphoneStatusWithRate()?.let { put(it) }
    playbackStatus?.let { put(it) }
  }.toString()

  // 녹음 중인 입력의 레이트를 준비 상태에 붙인다. 기본 장치 캡처에는 선택 상태가 없으므로 녹음 중에만 ready 상태를 만든다.
  private fun microphoneStatusWithRate(): JSONObject? {
    val input = recorder?.takeIf { capturing && it.recordingState == AudioRecord.RECORDSTATE_RECORDING }
      ?: return microphoneStatus
    val selected = microphoneStatus?.takeIf { micDeviceId != null }
    val status = selected?.let { JSONObject(it.toString()) } ?: JSONObject().put("source", "microphone").put("code", "ready")
      .apply { input.routedDevice?.let { put("actualDeviceId", it.id.toString()) } }
    if (status.optString("code") == "ready") status.put("nativeSampleRateHz", nativeCaptureRate(input))
    return status
  }

  // OS가 장치 쪽 형식을 알려 주면 그 레이트를, 아직 없으면 AudioRecord를 연 레이트를 쓴다. 전자는 앱이 받는 레이트보다 낮을 수 있다.
  // https://developer.android.com/reference/android/media/AudioRecordingConfiguration#getFormat()
  private fun nativeCaptureRate(input: AudioRecord): Int =
    audioManager.activeRecordingConfigurations.firstOrNull { it.clientAudioSessionId == input.audioSessionId }
      ?.format?.sampleRate?.takeIf { it > 0 } ?: input.sampleRate

  private fun updateDeviceStatus(source: String, code: String, requested: String?, actual: Int? = null) {
    val status = JSONObject().put("source", source).put("code", code)
    requested?.let { status.put("requestedDeviceId", it) }
    actual?.let { status.put("actualDeviceId", it.toString()) }
    if (source == "microphone") microphoneStatus = status else playbackStatus = status
  }

  private fun resolveDevice(id: String, source: String): AudioDeviceInfo {
    val value = parseAudioDeviceId(id)
    val device = try { audioManager.getDevices(AudioManager.GET_DEVICES_ALL).firstOrNull { it.id == value } }
    catch (error: SecurityException) {
      updateDeviceStatus(source, "permission_denied", id)
      throw error
    }
    if (device == null) {
      updateDeviceStatus(source, "unavailable", id)
      error("audio_device_unavailable")
    }
    require(if (source == "microphone") device.isSource else device.isSink) { "audio_device_direction_invalid" }
    return device
  }

  fun startCapture(rate: Int) {
    check(Looper.myLooper() != Looper.getMainLooper()) { "capture_start_requires_worker_thread" }
    check(recorder == null) { "capture_already_active" }
    if (!playing && playbackDeviceId != null) updateDeviceStatus("playback", "pending", playbackDeviceId)
    requireRecordPermission()
    val preferredDevice = micDeviceId?.let { resolveDevice(it, "microphone") }
    val selectedRoute = preferredDevice?.let { SelectedAudioRoute(it.id) }
    micDeviceId?.let { updateDeviceStatus("microphone", "pending", it) }
    if (foreground == null) {
      requireForegroundActivity(context)
      foreground = TellusMicrophoneService.acquire(context, notification, ::notificationAction) { interrupt("microphone_service_stopped") }
    }
    try {
      capturing = true
      foreground?.update(notification)
      acquireFocus()
      val source = if (audioManager.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true") {
        MediaRecorder.AudioSource.UNPROCESSED
      } else MediaRecorder.AudioSource.VOICE_RECOGNITION
      val input = openWithCaptureRateFallback(rate) { openRecorder(it, source) }
      synchronized(captureLock) { recorder = input }
      if (preferredDevice != null && !input.setPreferredDevice(preferredDevice)) {
        updateDeviceStatus("microphone", "unsupported", micDeviceId)
        error("audio_device_unsupported")
      }
      var previousDevice = -1
      input.addOnRoutingChangedListener(AudioRouting.OnRoutingChangedListener {
        val actual = it.routedDevice?.id
        val current = actual ?: -1
        if (recorder === it && capturing) {
          if (selectedRoute != null) {
            val code = selectedRoute.observe(actual)
            if (code != "pending") updateDeviceStatus("microphone", code, micDeviceId, actual)
            if (code == "unavailable" || code == "route_mismatch") interrupt("audio_device_$code")
          } else if (previousDevice != -1 && current != previousDevice) interrupt("capture_route_changed")
        }
        previousDevice = current
      }, Handler(Looper.getMainLooper()))
      synchronized(captureLock) {
        check(capturing) { "capture_interrupted_during_start" }
        input.startRecording()
      }
      if (selectedRoute != null) awaitCaptureRoute(input, selectedRoute)
      reader = Thread({ readCapture(input) }, "TellusCapture").also { it.start() }
    } catch (error: Exception) {
      if (micDeviceId != null && microphoneStatus?.optString("code") == "pending") {
        updateDeviceStatus("microphone", "unavailable", micDeviceId)
      }
      stopCapture()
      throw error
    }
  }

  private fun requireRecordPermission() {
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      updateDeviceStatus("microphone", "permission_denied", micDeviceId)
      error("microphone_permission_required")
    }
  }

  // 초기화된 AudioRecord만 반환한다. 권한을 시도마다 확인해 권한 실패가 형식 미지원 재시도로 이어지지 않게 한다.
  // Builder는 초기화 실패를 UnsupportedOperationException으로 알리며 이때 남는 인스턴스는 없다. 초기화되지 않은 채 돌아온 인스턴스만 해제한다.
  // https://developer.android.com/reference/android/media/AudioRecord.Builder#build()
  private fun openRecorder(rate: Int, source: Int): AudioRecord {
    requireRecordPermission()
    val minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT)
    if (minimum <= 0) throw CaptureFormatUnsupported()
    val input = try {
      AudioRecord.Builder().setAudioSource(source)
        .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
          .setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build())
        .setBufferSizeInBytes(maxOf(minimum, rate / 50 * 4)).build()
    } catch (error: UnsupportedOperationException) {
      throw CaptureFormatUnsupported()
    }
    if (input.state != AudioRecord.STATE_INITIALIZED) {
      input.release()
      throw CaptureFormatUnsupported()
    }
    return input
  }

  private fun awaitCaptureRoute(input: AudioRecord, selection: SelectedAudioRoute) {
    val deadline = SystemClock.elapsedRealtime() + 2000
    while (capturing) {
      val actual = input.routedDevice?.id
      val code = selection.observe(actual, SystemClock.elapsedRealtime() >= deadline)
      if (code != "pending") updateDeviceStatus("microphone", code, micDeviceId, actual)
      if (code == "ready") return
      check(code == "pending") { "audio_device_$code" }
      Thread.sleep(2)
    }
    error("capture_interrupted_during_start")
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
      if (!capturing && micDeviceId != null) updateDeviceStatus("microphone", "pending", micDeviceId)
      val preferredDevice = playbackDeviceId?.let { resolveDevice(it, "playback") }
      playbackDeviceId?.let { updateDeviceStatus("playback", "pending", it) }
      acquireFocus()
      playback.start(rate, attributes, preferredDevice) { playing }
    }
    catch (error: Exception) {
      if (playbackDeviceId != null && playbackStatus?.optString("code") == "pending") {
        updateDeviceStatus("playback", "unavailable", playbackDeviceId)
      }
      endPlayback()
      throw error
    }
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
    if (capturing && micDeviceId != null && microphoneStatus?.optString("code") in listOf("pending", "ready")) {
      updateDeviceStatus("microphone", "unavailable", micDeviceId)
    }
    if (playing && playbackDeviceId != null && playbackStatus?.optString("code") in listOf("pending", "ready")) {
      updateDeviceStatus("playback", "unavailable", playbackDeviceId)
    }
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
