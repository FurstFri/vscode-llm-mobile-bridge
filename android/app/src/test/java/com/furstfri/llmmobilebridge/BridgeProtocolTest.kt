package com.furstfri.llmmobilebridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class BridgeProtocolTest {
    @Test
    fun parsesPairingPayload() {
        val pairing = BridgeProtocol.parsePairing(
            """{"protocolVersion":1,"url":"ws://10.0.2.2:8765","token":"12345678901234567890123456789012"}""",
        )
        assertEquals("ws://10.0.2.2:8765", pairing.url)
    }

    @Test
    fun parsesSessionListCapabilities() {
        val response = JSONObject("""
            {
              "protocolVersion": 1,
              "id": "list",
              "ok": true,
              "type": "event",
              "event": {
                "type": "session.list",
                "payload": {
                  "sessions": [{
                    "ref": "opaque-ref",
                    "provider": "claude",
                    "title": "Conversation",
                    "state": "idle",
                    "capabilities": {"canRead": true, "canStartTurn": false, "canApprove": false}
                  }]
                }
              }
            }
        """.trimIndent())

        val sessions = BridgeProtocol.parseSessions(response).orEmpty()

        assertEquals("opaque-ref", sessions.single().ref)
        assertFalse(sessions.single().capabilities.canStartTurn)
    }
}
