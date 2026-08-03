package com.furstfri.llmmobilebridge

import org.json.JSONArray
import org.json.JSONObject

object BridgeProtocol {
    fun parsePairing(raw: String): PairingPayload {
        val json = JSONObject(raw.trim())
        require(json.optInt("protocolVersion") == 1) { "Unsupported pairing protocol version" }
        val url = json.getString("url")
        val token = json.getString("token")
        require(url.startsWith("ws://") || url.startsWith("wss://")) { "Pairing URL must use WebSocket" }
        require(token.length >= 32) { "Pairing token is invalid" }
        return PairingPayload(url, token)
    }

    fun request(id: String, type: String, fields: Map<String, String> = emptyMap()): String {
        val json = JSONObject()
            .put("protocolVersion", 1)
            .put("id", id)
            .put("type", type)
        fields.forEach { (key, value) -> json.put(key, value) }
        return json.toString()
    }

    fun parseSessions(response: JSONObject): List<BridgeSession>? {
        val event = event(response, "session.list") ?: return null
        val values = event.getJSONObject("payload").getJSONArray("sessions")
        return buildList {
            for (index in 0 until values.length()) add(session(values.getJSONObject(index)))
        }
    }

    fun parseSnapshot(response: JSONObject): Pair<BridgeSession, List<TimelineItem>>? {
        val event = event(response, "session.snapshot") ?: return null
        val payload = event.getJSONObject("payload")
        val session = session(payload.getJSONObject("session"))
        val values = payload.getJSONArray("items")
        val items = buildList {
            for (index in 0 until values.length()) {
                val item = values.getJSONObject(index)
                add(TimelineItem(
                    id = item.getString("id"),
                    kind = item.getString("kind"),
                    role = item.optNullableString("role"),
                    text = item.optString("text"),
                    status = item.optNullableString("status"),
                ))
            }
        }
        return session to items
    }

    fun error(response: JSONObject): String? {
        if (response.optBoolean("ok", true)) return null
        val error = response.optJSONObject("error") ?: return "Gateway request failed"
        return error.optString("message", "Gateway request failed")
    }

    private fun event(response: JSONObject, expectedType: String): JSONObject? {
        if (!response.optBoolean("ok") || response.optString("type") != "event") return null
        val event = response.optJSONObject("event") ?: return null
        return event.takeIf { it.optString("type") == expectedType }
    }

    private fun session(json: JSONObject): BridgeSession {
        val capabilities = json.getJSONObject("capabilities")
        return BridgeSession(
            ref = json.getString("ref"),
            provider = json.getString("provider"),
            title = json.optString("title", "Untitled conversation"),
            state = json.getString("state"),
            capabilities = SessionCapabilities(
                canRead = capabilities.optBoolean("canRead"),
                canStartTurn = capabilities.optBoolean("canStartTurn"),
                canApprove = capabilities.optBoolean("canApprove"),
            ),
        )
    }

    private fun JSONObject.optNullableString(name: String): String? =
        takeIf { has(name) && !isNull(name) }?.optString(name)?.takeIf(String::isNotBlank)
}
