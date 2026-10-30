package com.margelo.nitro.tellus

/** 44.1 kHz is guaranteed by Android on every device, accepted by core, and keeps about 22 kHz of bandwidth. */
internal const val CAPTURE_FALLBACK_RATE = 44100

/** AudioRecord cannot be created with this rate and format. Permission failures are not turned into this exception. */
internal class CaptureFormatUnsupported : IllegalStateException("capture_format_unsupported")

/** Reopens once at 44.1 kHz if the requested rate fails for a format reason. Other failures pass through unchanged. */
internal fun <T> openWithCaptureRateFallback(rate: Int, open: (Int) -> T): T =
  try { open(rate) }
  catch (unsupported: CaptureFormatUnsupported) {
    if (rate == CAPTURE_FALLBACK_RATE) throw unsupported
    open(CAPTURE_FALLBACK_RATE)
  }
