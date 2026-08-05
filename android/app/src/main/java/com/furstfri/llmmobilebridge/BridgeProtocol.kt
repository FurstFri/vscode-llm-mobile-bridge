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
        val name = json.optString("name").takeIf { it.isNotBlank() } ?: "Компьютер"
        return PairingPayload(url = url, token = token, name = name)
    }

    fun request(id: String, type: String, fields: Map<String, String> = emptyMap()): String {
        val json = JSONObject()
            .put("protocolVersion", 1)
            .put("id", id)
            .put("type", type)
        fields.forEach { (key, value) -> json.put(key, value) }
        return json.toString()
    }

    /** Builds the answer to a forwarded permission prompt. */
    fun approvalResponse(id: String, approvalId: String, allow: Boolean, choice: String? = null): String =
        JSONObject()
            .put("protocolVersion", 1)
            .put("id", id)
            .put("type", "approval.respond")
            .put("approvalId", approvalId)
            .put("allow", allow)
            .apply { choice?.let { put("choice", it) } }
            .toString()

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
                    at = item.optLong("at", 0L).takeIf { it > 0L },
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

    /** Parses a streamed turn item (item.add / item.delta / item.complete). */
    fun parseTurnItem(response: JSONObject): TimelineItem? {
        val event = anyEvent(response) ?: return null
        val type = event.optString("type")
        if (type != "item.add" && type != "item.delta" && type != "item.complete") return null
        val item = event.optJSONObject("payload")?.optJSONObject("item") ?: return null
        return TimelineItem(
            id = item.optString("id").ifBlank { return null },
            kind = item.optString("kind", "message"),
            role = item.optNullableString("role"),
            text = item.optString("text"),
            status = item.optNullableString("status"),
            at = item.optLong("at", 0L).takeIf { it > 0L },
        )
    }

    /** Parses a permission prompt forwarded from the machine. */
    fun parseApproval(response: JSONObject): ApprovalRequest? {
        val event = anyEvent(response) ?: return null
        if (event.optString("type") != "approval.request") return null
        val payload = event.optJSONObject("payload") ?: return null
        val id = payload.optString("id").ifBlank { return null }
        val options = payload.optJSONArray("options") ?: JSONArray()
        return ApprovalRequest(
            id = id,
            toolName = payload.optString("toolName", "инструмент"),
            summary = payload.optNullableString("summary"),
            resolved = payload.optBoolean("resolved"),
            allowed = if (payload.has("allow")) payload.optBoolean("allow") else null,
            kind = payload.optString("kind", "permission"),
            question = payload.optNullableString("question"),
            options = buildList { for (i in 0 until options.length()) add(options.getString(i)) },
            multiSelect = payload.optBoolean("multiSelect"),
            answer = payload.optNullableString("answer"),
        )
    }

    /** Returns the new session state for turn lifecycle events, null otherwise. */
    fun parseTurnState(response: JSONObject): String? {
        val event = anyEvent(response) ?: return null
        return when (event.optString("type")) {
            "session.state" -> event.optJSONObject("payload")?.optString("state")
            "turn.status" -> event.optJSONObject("payload")?.optString("status")
            else -> null
        }?.takeIf(String::isNotBlank)
    }

    /** Extracts the message from a gateway-level error or conflict event. */
    fun parseEventError(response: JSONObject): String? {
        val event = anyEvent(response) ?: return null
        when (event.optString("type")) {
            "error" -> {
                val payload = event.optJSONObject("payload")
                val message = payload?.optString("message")?.takeIf(String::isNotBlank)
                    ?: "Gateway reported an error"
                val detail = payload?.optString("detail")?.takeIf(String::isNotBlank)
                return if (detail != null) "$message\n$detail" else message
            }
            "session.conflict" -> {
                val reason = event.optJSONObject("payload")?.optString("reason")
                return when (reason) {
                    "writer_active" -> "Сессия занята другим устройством — дождитесь окончания хода."
                    "unresolved_conflict" -> "Сессия в конфликте — обновите чат и попробуйте снова."
                    else -> "Сессия недоступна для записи, попробуйте ещё раз."
                }
            }
            else -> return null
        }
    }

    fun isTurnEnd(response: JSONObject): Boolean =
        response.optBoolean("ok") && response.optString("type") == "turn.end"

    /** Parses the models and usage limits reported by one machine. */
    fun parseProviderStatus(response: JSONObject): List<ProviderStatus>? {
        val event = event(response, "provider.status") ?: return null
        val providers = event.getJSONObject("payload").getJSONArray("providers")
        return buildList {
            for (index in 0 until providers.length()) {
                val entry = providers.getJSONObject(index)
                val models = entry.optJSONArray("models") ?: JSONArray()
                val limits = entry.optJSONObject("limits")
                add(ProviderStatus(
                    provider = entry.getString("provider"),
                    models = buildList {
                        for (m in 0 until models.length()) {
                            val model = models.getJSONObject(m)
                            val efforts = model.optJSONArray("efforts") ?: JSONArray()
                            add(ProviderModel(
                                id = model.getString("id"),
                                label = model.optString("label", model.getString("id")),
                                description = model.optNullableString("description"),
                                efforts = buildList { for (e in 0 until efforts.length()) add(efforts.getString(e)) },
                                defaultEffort = model.optNullableString("defaultEffort"),
                                isDefault = model.optBoolean("isDefault"),
                            ))
                        }
                    },
                    limits = limits?.let {
                        ProviderLimits(
                            usedPercent = if (it.has("usedPercent")) it.optInt("usedPercent") else null,
                            resetsAt = it.optLong("resetsAt", 0L).takeIf { value -> value > 0L },
                            windowMinutes = if (it.has("windowMinutes")) it.optInt("windowMinutes") else null,
                            plan = it.optNullableString("plan"),
                            status = it.optNullableString("status"),
                            note = it.optNullableString("note"),
                        )
                    },
                ))
            }
        }
    }

    /** Parses the session descriptor announced for a freshly created chat. */
    fun parseSessionCreated(response: JSONObject): BridgeSession? {
        val event = anyEvent(response) ?: return null
        if (event.optString("type") != "session.new") return null
        val payload = event.optJSONObject("payload") ?: return null
        return runCatching { session(payload.getJSONObject("session")) }.getOrNull()
    }

    private fun anyEvent(response: JSONObject): JSONObject? {
        if (!response.optBoolean("ok") || response.optString("type") != "event") return null
        return response.optJSONObject("event")
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
            project = json.optNullableString("project"),
            updatedAt = json.optLong("updatedAt", 0L).takeIf { it > 0L },
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
