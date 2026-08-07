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
        assertEquals("Компьютер", pairing.name)
    }

    @Test
    fun parsesPairingHostName() {
        val pairing = BridgeProtocol.parsePairing(
            """{"protocolVersion":1,"url":"wss://bridge.example.com","token":"12345678901234567890123456789012","name":"prod-server"}""",
        )
        assertEquals("prod-server", pairing.name)
        assertTrue(pairing.id.isNotBlank())
    }

    @Test
    fun keepsTheConnectionIdSoRepairingUpdatesOneEntry() {
        val payload = """
            {"protocolVersion":1,"connectionId":"9f1c0f2e-2b7a-4a4c-8c1e-2f9a7d6b5c31",
             "label":"Домашний ПК","url":"ws://192.168.1.42:8765",
             "token":"12345678901234567890123456789012"}
        """.trimIndent()

        val first = BridgeProtocol.parsePairing(payload)
        val second = BridgeProtocol.parsePairing(payload)

        assertEquals("9f1c0f2e-2b7a-4a4c-8c1e-2f9a7d6b5c31", first.id)
        assertEquals(first.id, second.id)
        assertEquals("Домашний ПК", first.name)
    }

    @Test
    fun carriesTheBlockedChatOnAPrompt() {
        val response = JSONObject("""
            {
              "protocolVersion": 1, "id": "evt", "ok": true, "type": "event",
              "event": {
                "type": "approval.request",
                "sessionRef": "opaque-ref",
                "payload": {"id": "ask-1", "toolName": "Bash", "summary": "rm -rf build", "kind": "permission"}
              }
            }
        """.trimIndent())

        val approval = BridgeProtocol.parseApproval(response)

        assertEquals("ask-1", approval?.id)
        assertEquals("opaque-ref", approval?.sessionRef)
        assertFalse(approval?.resolved ?: true)
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
