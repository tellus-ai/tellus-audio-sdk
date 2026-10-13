package com.margelo.nitro.tellus

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRouting
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.nio.ByteBuffer

/** AudioTrack의 실제 수락량과 재생 완료를 제공한다. cancel은 출력 thread와 동시에 호출할 수 있다. */
internal class AudioPlayback(
  private val interrupted: (String) -> Unit,
  private val deviceStatus: (String, Int?) -> Unit
) {
  private val lock = Any()
  @Volatile private var track: AudioTrack? = null
  private var acceptedFrames = 0L
  @Volatile private var running = false
  private var selectedRoute: SelectedAudioRoute? = null
  private var routeDeadline = 0L

  fun start(rate: Int, attributes: AudioAttributes, preferredDevice: AudioDeviceInfo?, isRequested: () -> Boolean) = synchronized(lock) {
    check(isRequested()) { "playback_cancelled" }
    check(track == null) { "playback_already_active" }
    val minimum = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
    check(minimum > 0) { "playback_format_unsupported" }
    val output = AudioTrack.Builder().setAudioAttributes(attributes)
      .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
        .setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
      .setBufferSizeInBytes(maxOf(minimum, rate / 50 * 4)).setTransferMode(AudioTrack.MODE_STREAM).build()
    track = output
    check(output.state == AudioTrack.STATE_INITIALIZED) { "playback_initialization_failed" }
    if (preferredDevice != null && !output.setPreferredDevice(preferredDevice)) {
      deviceStatus("unsupported", null)
      error("audio_device_unsupported")
    }
    val selection = preferredDevice?.let { SelectedAudioRoute(it.id) }
    selectedRoute = selection
    var previousDevice = -1
    output.addOnRoutingChangedListener(AudioRouting.OnRoutingChangedListener {
      val actual = it.routedDevice?.id
      val current = actual ?: -1
      if (track === it && running) {
        if (selection != null) {
          val code = selection.observe(actual)
          if (code != "pending") deviceStatus(code, actual)
          if (code == "unavailable" || code == "route_mismatch") interrupted("audio_device_$code")
        } else if (previousDevice != -1 && current != previousDevice) interrupted("playback_route_changed")
      }
      previousDevice = current
    }, Handler(Looper.getMainLooper()))
    acceptedFrames = 0
    running = true
    output.play()
    routeDeadline = SystemClock.elapsedRealtime() + 2000
  }.also {
    if (preferredDevice != null) primeSelectedRoute()
  }

  // https://developer.android.com/reference/android/media/AudioTrack#write(java.nio.ByteBuffer,int,int)
  fun write(samples: ByteBuffer, bytes: Int): Int = synchronized(lock) {
    check(running) { "playback_cancelled" }
    val written = checkNotNull(track).write(samples, bytes, AudioTrack.WRITE_NON_BLOCKING)
    check(written >= 0) { "playback_write_failed:$written" }
    acceptedFrames += written / 4
    written
  }

  private fun observeSelectedRoute(): String = synchronized(lock) {
    check(running) { "playback_cancelled" }
    val selection = checkNotNull(selectedRoute)
    if (selection.confirmed) return "ready"
    val actual = checkNotNull(track).routedDevice?.id
    val code = selection.observe(actual, SystemClock.elapsedRealtime() >= routeDeadline)
    if (code != "pending") deviceStatus(code, actual)
    check(code == "pending" || code == "ready") { "audio_device_$code" }
    code
  }

  /** 사용자 PCM 전에 무음으로 재생 경로를 활성화한다. prime은 native render/AEC에 전달하지 않는다. */
  private fun primeSelectedRoute() {
    val silence = synchronized(lock) {
      check(running) { "playback_cancelled" }
      ByteBuffer.allocateDirect(checkNotNull(track).sampleRate / 50 * 4)
    }
    while (observeSelectedRoute() == "pending") {
      val written = synchronized(lock) {
        check(running) { "playback_cancelled" }
        silence.clear()
        val bytes = checkNotNull(track).write(silence, silence.capacity(), AudioTrack.WRITE_NON_BLOCKING)
        check(bytes >= 0 && bytes % 4 == 0) { "playback_write_failed:$bytes" }
        acceptedFrames += bytes / 4
        bytes
      }
      if (written == 0) Thread.sleep(2)
    }
  }

  /** 마지막 수락 sample이 실제로 재생된 뒤 반환한다. */
  fun awaitCompletion() {
    val deadline = synchronized(lock) {
      val output = checkNotNull(track)
      SystemClock.elapsedRealtime() + acceptedFrames * 1000 / output.sampleRate + 2000
    }
    while (true) {
      val complete = synchronized(lock) {
        check(running) { "playback_cancelled" }
        val position = checkNotNull(track).playbackHeadPosition.toLong() and 0xffffffffL
        position >= acceptedFrames
      }
      if (complete) return
      check(SystemClock.elapsedRealtime() < deadline) { "playback_completion_timeout" }
      Thread.sleep(2)
    }
  }

  fun cancel() = synchronized(lock) {
    running = false
    track?.let { it.pause(); it.flush() }
  }

  fun close() = synchronized(lock) {
    running = false
    track?.release()
    track = null
    selectedRoute = null
  }
}
