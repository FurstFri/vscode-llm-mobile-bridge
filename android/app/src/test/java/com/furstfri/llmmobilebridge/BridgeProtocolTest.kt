package com.furstfri.llmmobilebridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    fun createsVersionedAuthRequestEnvelope() {
        val request = JSONObject(BridgeProtocol.request(
            id = "auth-request",
            type = "auth",
            fields = mapOf("token" to "12345678901234567890123456789012"),
        ))

        assertEquals(1, request.getInt("protocolVersion"))
        assertEquals("auth-request", request.getString("id"))
        assertEquals("auth", request.getString("type"))
        assertEquals("12345678901234567890123456789012", request.getString("token"))
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

    @Test
    fun parsesSessionMetadata() {
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
                    "project": "my-project",
                    "updatedAt": 1754200000000,
                    "capabilities": {"canRead": true, "canStartTurn": true, "canApprove": false}
                  }]
                }
              }
            }
        """.trimIndent())

        val session = BridgeProtocol.parseSessions(response).orEmpty().single()

        assertEquals("my-project", session.project)
        assertEquals(1754200000000L, session.updatedAt)
        assertTrue(session.capabilities.canStartTurn)
    }

    @Test
    fun createsTurnStartRequest() {
        val request = JSONObject(BridgeProtocol.request(
            id = "turn-1",
            type = "turn.start",
            fields = mapOf("sessionRef" to "opaque-ref", "text" to "привет"),
        ))

        assertEquals("turn.start", request.getString("type"))
        assertEquals("opaque-ref", request.getString("sessionRef"))
        assertEquals("привет", request.getString("text"))
    }

    @Test
    fun parsesStreamedTurnEvents() {
        val itemResponse = JSONObject("""
            {
              "protocolVersion": 1, "id": "turn-1", "ok": true, "type": "event",
              "event": {
                "type": "item.complete",
                "payload": {"item": {"id": "reply-1", "kind": "message", "role": "assistant", "text": "Готово", "status": "completed"}}
              }
            }
        """.trimIndent())
        val stateResponse = JSONObject("""
            {
              "protocolVersion": 1, "id": "turn-1", "ok": true, "type": "event",
              "event": {"type": "session.state", "payload": {"state": "idle"}}
            }
        """.trimIndent())
        val endResponse = JSONObject("""{"protocolVersion":1,"id":"turn-1","ok":true,"type":"turn.end"}""")

        val item = BridgeProtocol.parseTurnItem(itemResponse)
        assertEquals("reply-1", item?.id)
        assertEquals("assistant", item?.role)
        assertNull(BridgeProtocol.parseTurnItem(stateResponse))
        assertEquals("idle", BridgeProtocol.parseTurnState(stateResponse))
        assertTrue(BridgeProtocol.isTurnEnd(endResponse))
        assertFalse(BridgeProtocol.isTurnEnd(itemResponse))
    }
}
