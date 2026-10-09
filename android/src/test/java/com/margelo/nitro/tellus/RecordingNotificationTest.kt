package com.margelo.nitro.tellus

import org.junit.Test

class RecordingNotificationTest {
  @Test fun optionalActionsFollowCapturePhase() {
    val cases = listOf(
      Triple(false, false, listOf(null, null)),
      Triple(true, false, listOf("pause", null)),
      Triple(false, true, listOf(null, "resume")),
      Triple(true, true, listOf("pause", "resume"))
    )
    for ((pause, resume, expected) in cases) {
      for (phase in listOf(false, true)) {
        val configuration = RecordingNotification("녹음 🎙️", "기록 중", pause, resume, phase)
        check(configuration.action == expected[if (phase) 1 else 0])
      }
    }
  }
}
