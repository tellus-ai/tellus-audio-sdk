package com.margelo.nitro.tellus

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRouting
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.nio.ByteBuffer

/** AudioTrack의 실제 수락량과 재생 완료를 제공한다. cancel은 출력 thread와 동시에 호출할 수 있다. */
internal class AudioPlayback(private val interrupted: (String) -> Unit) {
  private val lock = Any()
  @Volatile private var track: AudioTrack? = null
  private var acceptedFrames = 0L
  @Volatile private var running = false

  fun start(rate: Int, attributes: AudioAttributes, isRequested: () -> Boolean) = synchronized(lock) {
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
    var previousDevice = -1
    output.addOnRoutingChangedListener(AudioRouting.OnRoutingChangedListener {
      val current = it.routedDevice?.id ?: -1
      if (previousDevice != -1 && current != previousDevice && track === it && running) interrupted("playback_route_changed")
      previousDevice = current
    }, Handler(Looper.getMainLooper()))
    acceptedFrames = 0
    running = true
    output.play()
  }

  // https://developer.android.com/reference/android/media/AudioTrack#write(java.nio.ByteBuffer,int,int)
  fun write(samples: ByteBuffer, bytes: Int): Int = synchronized(lock) {
    check(running) { "playback_cancelled" }
    val written = checkNotNull(track).write(samples, bytes, AudioTrack.WRITE_NON_BLOCKING)
    check(written >= 0) { "playback_write_failed:$written" }
    acceptedFrames += written / 4
    written
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
  }
}
