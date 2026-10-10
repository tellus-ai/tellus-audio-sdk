package com.margelo.nitro.tellus

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.SystemClock
import androidx.annotation.Keep
import com.margelo.nitro.NitroModules
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer

/** MP3/WAV 컨테이너를 OS로 해석한다. cancellation pointer는 이 동기 JNI 호출 동안만 유효하다. */
@Keep
internal object AudioDecoder {
  @JvmStatic fun decode(encoded: ByteBuffer, cancellation: Long): DecodedAudioResult {
    check(encoded.remaining() in 1..16 * 1024 * 1024) { "encoded_audio_size_invalid" }
    checkCancelled(cancellation)
    val context = checkNotNull(NitroModules.applicationContext) { "react_context_unavailable" }
    val temporary = File.createTempFile("tellus-audio-", ".audio", context.cacheDir)
    try {
      FileOutputStream(temporary).channel.use { file ->
        val input = encoded.duplicate()
        while (input.hasRemaining()) {
          checkCancelled(cancellation)
          val block = input.slice()
          block.limit(minOf(input.remaining(), 65536))
          val written = file.write(block)
          check(written > 0) { "encoded_audio_temp_write_failed" }
          input.position(input.position() + written)
        }
      }
      val extractor = MediaExtractor()
      try {
        extractor.setDataSource(temporary.absolutePath)
        check(extractor.trackCount == 1) { "encoded_audio_format_unsupported" }
        val format = extractor.getTrackFormat(0)
        val mime = format.getString(MediaFormat.KEY_MIME)
        check(mime == "audio/mpeg" || mime == "audio/raw") { "encoded_audio_format_unsupported" }
        val rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        check(rate in 8000..192000 && rate % 50 == 0 && channels in 1..2) { "encoded_audio_format_unsupported" }
        extractor.selectTrack(0)
        val output = PcmSamples()
        if (mime == "audio/raw") decodeRaw(extractor, format, output, cancellation)
        else decodeMp3(extractor, format, output, cancellation)
        checkCancelled(cancellation)
        return output.result()
      } finally { extractor.release() }
    } finally { check(temporary.delete() || !temporary.exists()) { "encoded_audio_temp_cleanup_failed" } }
  }

  private fun decodeRaw(extractor: MediaExtractor, format: MediaFormat, output: PcmSamples, cancellation: Long) {
    val buffer = ByteBuffer.allocateDirect(65536)
    while (true) {
      checkCancelled(cancellation)
      buffer.clear()
      val bytes = extractor.readSampleData(buffer, 0)
      if (bytes < 0) return
      check(bytes in 1..buffer.capacity()) { "encoded_audio_invalid_packet" }
      buffer.position(0)
      buffer.limit(bytes)
      appendPcm(output, buffer, format)
      extractor.advance()
    }
  }

  // https://developer.android.com/reference/android/media/MediaCodec#RawAudioBuffers
  private fun decodeMp3(extractor: MediaExtractor, format: MediaFormat, output: PcmSamples, cancellation: Long) {
    val codec = MediaCodec.createDecoderByType("audio/mpeg")
    var started = false
    try {
      format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
      codec.configure(format, null, null, 0)
      codec.start()
      started = true
      var inputEnded = false
      var progress = SystemClock.elapsedRealtime()
      val info = MediaCodec.BufferInfo()
      while (true) {
        checkCancelled(cancellation)
        if (!inputEnded) {
          val index = codec.dequeueInputBuffer(10000)
          if (index >= 0) {
            val input = checkNotNull(codec.getInputBuffer(index))
            input.clear()
            val bytes = extractor.readSampleData(input, 0)
            check(bytes != 0) { "encoded_audio_invalid_packet" }
            inputEnded = bytes < 0
            codec.queueInputBuffer(index, 0, maxOf(bytes, 0), if (inputEnded) 0 else extractor.sampleTime,
              if (inputEnded) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
            if (!inputEnded) extractor.advance()
            progress = SystemClock.elapsedRealtime()
          }
        }
        val index = codec.dequeueOutputBuffer(info, 10000)
        if (index >= 0) {
          try {
            if (info.size > 0) {
              val buffer = checkNotNull(codec.getOutputBuffer(index))
              buffer.position(info.offset)
              buffer.limit(info.offset + info.size)
              appendPcm(output, buffer, codec.getOutputFormat(index))
            }
          } finally { codec.releaseOutputBuffer(index, false) }
          progress = SystemClock.elapsedRealtime()
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
        }
        check(SystemClock.elapsedRealtime() - progress < 2000) { "encoded_audio_decode_timeout" }
      }
    } finally {
      try { if (started) codec.stop() }
      finally { codec.release() }
    }
  }

  private fun appendPcm(output: PcmSamples, data: ByteBuffer, format: MediaFormat) {
    // Android의 누락 PCM encoding 계약은 signed16이다.
    // https://developer.android.com/reference/android/media/MediaFormat#KEY_PCM_ENCODING
    val encoding = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) format.getInteger(MediaFormat.KEY_PCM_ENCODING)
      else AudioFormat.ENCODING_PCM_16BIT
    output.append(data, format.getInteger(MediaFormat.KEY_SAMPLE_RATE), format.getInteger(MediaFormat.KEY_CHANNEL_COUNT), encoding)
  }

  private fun checkCancelled(cancellation: Long) {
    check(!nativeDecodeCancelled(cancellation)) { "playback_cancelled" }
  }
  @JvmStatic private external fun nativeDecodeCancelled(cancellation: Long): Boolean
}
