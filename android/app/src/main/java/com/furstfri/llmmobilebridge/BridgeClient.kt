package com.furstfri.llmmobilebridge

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Keeps one WebSocket per paired machine. Every callback carries the pairing
 * id so the caller can tell which machine a session or event came from.
 */
class BridgeClient(private val listener: Listener) {
    interface Listener {
        fun onConnectionChanged(hostId: String, state: ConnectionState)
        fun onSessions(hostId: String, sessions: List<BridgeSession>)
        fun onSnapshot(hostId: String, session: BridgeSession, items: List<TimelineItem>)
        fun onSessionCreated(hostId: String, session: BridgeSession)
        fun onTurnItem(hostId: String, item: TimelineItem)
        fun onTurnState(hostId: String, state: String)
        fun onTurnEnd(hostId: String)
        fun onError(hostId: String, message: String)
    }

    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private val sockets = mutableMapOf<String, WebSocket>()

    /** Opens (or re-opens) a socket for every pairing and drops removed ones. */
    fun connectAll(pairings: List<PairingPayload>) {
        val wanted = pairings.map(PairingPayload::id).toSet()
        sockets.keys.filterNot(wanted::contains).forEach { close(it) }
        pairings.forEach(::connect)
    }

    fun connect(pairing: PairingPayload) {
        close(pairing.id)
        listener.onConnectionChanged(pairing.id, ConnectionState.CONNECTING)
        val request = Request.Builder().url(pairing.url).build()
        sockets[pairing.id] = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                listener.onConnectionChanged(pairing.id, ConnectionState.AUTHENTICATING)
                webSocket.send(BridgeProtocol.request(
                    id = UUID.randomUUID().toString(),
                    type = "auth",
                    fields = mapOf("token" to pairing.token),
                ))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { JSONObject(text) }
                    .onSuccess { handle(pairing, webSocket, it) }
                    .onFailure { listener.onError(pairing.id, "Шлюз вернул некорректный ответ") }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener.onConnectionChanged(pairing.id, ConnectionState.DISCONNECTED)
                listener.onError(pairing.id, t.message ?: "Не удалось соединиться")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener.onConnectionChanged(pairing.id, ConnectionState.DISCONNECTED)
            }
        })
    }

    fun requestSnapshot(hostId: String, sessionRef: String) {
        send(hostId, "session.snapshot", mapOf("sessionRef" to sessionRef))
    }

    fun refreshSessions(hostId: String) {
        send(hostId, "session.list", emptyMap())
    }

    fun refreshAllSessions() {
        sockets.keys.toList().forEach(::refreshSessions)
    }

    fun sendTurn(hostId: String, sessionRef: String, text: String, model: String? = null, effort: String? = null) {
        send(hostId, "turn.start", buildMap {
            put("sessionRef", sessionRef)
            put("text", text)
            model?.takeIf(String::isNotBlank)?.let { put("model", it) }
            effort?.takeIf(String::isNotBlank)?.let { put("effort", it) }
        })
    }

    fun sendNewChat(hostId: String, provider: String, text: String, model: String? = null, effort: String? = null) {
        send(hostId, "session.new", buildMap {
            put("provider", provider)
            put("text", text)
            model?.takeIf(String::isNotBlank)?.let { put("model", it) }
            effort?.takeIf(String::isNotBlank)?.let { put("effort", it) }
        })
    }

    fun close(hostId: String) {
        sockets.remove(hostId)?.close(1000, "Mobile client disconnecting")
    }

    fun closeAll() {
        sockets.keys.toList().forEach(::close)
    }

    private fun send(hostId: String, type: String, fields: Map<String, String>) {
        sockets[hostId]?.send(BridgeProtocol.request(UUID.randomUUID().toString(), type, fields))
    }

    private fun handle(pairing: PairingPayload, webSocket: WebSocket, response: JSONObject) {
        BridgeProtocol.error(response)?.let {
            listener.onError(pairing.id, it)
            return
        }
        when (response.optString("type")) {
            "auth.ready" -> {
                listener.onConnectionChanged(pairing.id, ConnectionState.CONNECTED)
                webSocket.send(BridgeProtocol.request(UUID.randomUUID().toString(), "session.list"))
            }
            "event" -> {
                BridgeProtocol.parseSessions(response)?.let { sessions ->
                    listener.onSessions(pairing.id, sessions.map { it.withHost(pairing) })
                }
                BridgeProtocol.parseSnapshot(response)?.let { (session, items) ->
                    listener.onSnapshot(pairing.id, session.withHost(pairing), items)
                }
                BridgeProtocol.parseSessionCreated(response)?.let {
                    listener.onSessionCreated(pairing.id, it.withHost(pairing))
                }
                BridgeProtocol.parseTurnItem(response)?.let { listener.onTurnItem(pairing.id, it) }
                BridgeProtocol.parseTurnState(response)?.let { listener.onTurnState(pairing.id, it) }
                BridgeProtocol.parseEventError(response)?.let { listener.onError(pairing.id, it) }
            }
            "turn.end" -> listener.onTurnEnd(pairing.id)
        }
    }

    private fun BridgeSession.withHost(pairing: PairingPayload) =
        copy(hostId = pairing.id, hostName = pairing.name)
}
