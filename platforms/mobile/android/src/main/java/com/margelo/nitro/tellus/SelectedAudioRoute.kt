package com.margelo.nitro.tellus

internal fun parseAudioDeviceId(id: String): Int {
  val value = id.toIntOrNull()
  require(value != null && value.toString() == id) { "audio_device_id_invalid" }
  return value
}

/** preferredDevice is not the actual route. Distinguishes waiting for the first observation from losing the device after it was observed. */
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
