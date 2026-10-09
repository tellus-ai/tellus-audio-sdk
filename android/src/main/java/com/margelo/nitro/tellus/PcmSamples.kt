package com.margelo.nitro.tellus

import android.media.AudioFormat
import androidx.annotation.Keep
import java.nio.ByteBuffer
import java.nio.ByteOrder

@Keep
internal class DecodedAudioResult(val samples: FloatArray, val rate: Int)

/** OS PCM16/float의 frame을 mono로 downmix하며 출력 memory 상한을 지킨다. */
internal class PcmSamples {
  private var samples = FloatArray(1024)
  private var count = 0
  private var sampleRate = 0

  fun append(data: ByteBuffer, rate: Int, channels: Int, encoding: Int) {
    check(rate in 8000..192000 && rate % 50 == 0 && channels in 1..2) { "encoded_audio_format_unsupported" }
    check(sampleRate == 0 || sampleRate == rate) { "encoded_audio_rate_changed" }
    val bytes = when (encoding) {
      AudioFormat.ENCODING_PCM_16BIT -> 2
      AudioFormat.ENCODING_PCM_FLOAT -> 4
      else -> error("encoded_audio_pcm_unsupported")
    }
    check(data.remaining() % (bytes * channels) == 0) { "encoded_audio_incomplete_frame" }
    val frames = data.remaining() / (bytes * channels)
    check(count.toLong() + frames <= 4L * 1024 * 1024) { "decoded_audio_too_large" }
    if (count + frames > samples.size) samples = samples.copyOf(minOf(4 * 1024 * 1024, maxOf(samples.size * 2, count + frames)))
    sampleRate = rate
    data.order(ByteOrder.nativeOrder())
    repeat(frames) {
      var mono = 0f
      repeat(channels) {
        val sample = if (bytes == 2) data.short / 32768f else data.float
        check(sample in -1f..1f) { "encoded_audio_invalid_pcm" }
        mono += sample
      }
      samples[count++] = mono / channels
    }
  }

  fun result(): DecodedAudioResult {
    check(count > 0) { "encoded_audio_empty" }
    return DecodedAudioResult(samples.copyOf(count), sampleRate)
  }
}
