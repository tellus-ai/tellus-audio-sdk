package com.margelo.nitro.tellus

import android.media.AudioFormat
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.random.Random
import org.junit.Test

class PcmSamplesPropertyTest {
  @Test fun pcm16PreservesMonoValuesAcrossPacketPartitions() {
    val random = Random(431)
    repeat(200) {
      val channels = random.nextInt(1, 3)
      val frames = random.nextInt(1, 1025)
      val rate = listOf(8000, 16000, 22050, 44100, 48000, 192000).random(random)
      val values = ShortArray(frames * channels) { random.nextInt(-32768, 32768).toShort() }
      val bytes = ByteBuffer.allocate(values.size * 2).order(ByteOrder.nativeOrder())
      values.forEach { bytes.putShort(it) }
      val whole = PcmSamples()
      bytes.flip()
      whole.append(bytes.duplicate(), rate, channels, AudioFormat.ENCODING_PCM_16BIT)
      val partitioned = PcmSamples()
      var frame = 0
      while (frame < frames) {
        val count = random.nextInt(1, frames - frame + 1)
        val packet = bytes.duplicate()
        packet.position(frame * channels * 2)
        packet.limit((frame + count) * channels * 2)
        partitioned.append(packet.slice(), rate, channels, AudioFormat.ENCODING_PCM_16BIT)
        frame += count
      }
      val output = whole.result()
      check(output.rate == rate && output.samples.contentEquals(partitioned.result().samples))
      for (i in 0 until frames) {
        var expected = 0f
        for (channel in 0 until channels) expected += values[i * channels + channel] / 32768f
        check(output.samples[i] == expected / channels)
      }
    }
  }

  @Test fun floatPcmProducesNormalizedMonoSamples() {
    val random = Random(711)
    repeat(200) {
      val channels = random.nextInt(1, 3)
      val frames = random.nextInt(1, 1025)
      val values = FloatArray(frames * channels) { random.nextInt(-32768, 32768) / 32768f }
      val bytes = ByteBuffer.allocate(values.size * 4).order(ByteOrder.nativeOrder())
      values.forEach { bytes.putFloat(it) }
      val samples = PcmSamples()
      bytes.flip()
      samples.append(bytes, 48000, channels, AudioFormat.ENCODING_PCM_FLOAT)
      val output = samples.result().samples
      for (i in 0 until frames) {
        var expected = 0f
        for (channel in 0 until channels) expected += values[i * channels + channel]
        check(output[i] == expected / channels && output[i] in -1f..1f)
      }
    }
  }

  @Test fun malformedAndOversizedPcmAreRejected() {
    val random = Random(931)
    repeat(20) {
      val bad = listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, -1.01f, 1.01f).random(random)
      val bytes = ByteBuffer.allocate(4).order(ByteOrder.nativeOrder()).putFloat(bad)
      bytes.flip()
      check(runCatching { PcmSamples().append(bytes, 48000, 1, AudioFormat.ENCODING_PCM_FLOAT) }.isFailure)
      val tooLarge = ByteBuffer.allocate((4 * 1024 * 1024 + random.nextInt(1, 17)) * 2)
      check(runCatching { PcmSamples().append(tooLarge, 48000, 1, AudioFormat.ENCODING_PCM_16BIT) }.isFailure)
      val oddBytes = ByteBuffer.allocate(random.nextInt(1, 17) * 2 + 1)
      check(runCatching { PcmSamples().append(oddBytes, 48000, 1, AudioFormat.ENCODING_PCM_16BIT) }.isFailure)
    }
  }
}
