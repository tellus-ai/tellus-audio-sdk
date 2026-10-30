package com.margelo.nitro.tellus

/** 44.1 kHz는 Android가 모든 기기에서 보장하고 core가 받으며 약 22 kHz 대역폭을 유지한다. */
internal const val CAPTURE_FALLBACK_RATE = 44100

/** 이 레이트·형식으로 AudioRecord를 만들 수 없다. 권한 실패는 이 예외로 바꾸지 않는다. */
internal class CaptureFormatUnsupported : IllegalStateException("capture_format_unsupported")

/** 요청 레이트가 형식 문제로 실패하면 44.1 kHz로 한 번만 다시 연다. 그 밖의 실패는 그대로 전달한다. */
internal fun <T> openWithCaptureRateFallback(rate: Int, open: (Int) -> T): T =
  try { open(rate) }
  catch (unsupported: CaptureFormatUnsupported) {
    if (rate == CAPTURE_FALLBACK_RATE) throw unsupported
    open(CAPTURE_FALLBACK_RATE)
  }
