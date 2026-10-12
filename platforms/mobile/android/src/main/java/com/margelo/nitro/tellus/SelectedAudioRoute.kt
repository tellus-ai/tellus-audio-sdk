package com.margelo.nitro.tellus

internal fun parseAudioDeviceId(id: String): Int {
  val value = id.toIntOrNull()
  require(value != null && value.toString() == id) { "audio_device_id_invalid" }
  return value
}

/** preferredDevice는 실제 경로가 아니다. 최초 관측 대기와 관측 후 장치 소실을 구분한다. */
internal class SelectedAudioRoute(val requestedDeviceId: Int) {
  @Volatile var confirmed = false
    private set

  @Synchronized fun observe(actualDeviceId: Int?, deadlineExpired: Boolean = false): String {
    if (actualDeviceId == requestedDeviceId) {
      confirmed = true
      return "ready"
    }
    if (confirmed && actualDeviceId == null) return "unavailable"
    return if (confirmed || deadlineExpired) "route_mismatch" else "pending"
  }
}
