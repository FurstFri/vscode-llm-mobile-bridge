package com.furstfri.llmmobilebridge

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

class BridgeClient(private val listener: Listener) {
    interface Listener {
        fun onConnectionChanged(state: ConnectionState)
        fun onSessions(sessions: List<BridgeSession>)
        fun onSnapshot(session: BridgeSession, items: List<TimelineItem>)
        fun onTurnItem(item: TimelineItem)
        fun onTurnState(state: String)
        fun onTurnEnd()
        fun onError(message: String)
    }

    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private var socket: WebSocket? = null

    fun connect(pairing: PairingPayload) {
        close()
        listener.onConnectionChanged(ConnectionState.CONNECTING)
        val request = Request.Builder().url(pairing.url).build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                listener.onConnectionChanged(ConnectionState.AUTHENTICATING)
                webSocket.send(BridgeProtocol.request(
                    id = UUID.randomUUID().toString(),
                    type = "auth",
                    fields = mapOf("token" to pairing.token),
                ))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { JSONObject(text) }
                    .onSuccess { handle(webSocket, it) }
                    .onFailure { listener.onError("Gateway returned an invalid response") }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener.onConnectionChanged(ConnectionState.DISCONNECTED)
                listener.onError(t.message ?: "Gateway connection failed")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener.onConnectionChanged(ConnectionState.DISCONNECTED)
            }
        })
    }

    fun requestSnapshot(sessionRef: String) {
        socket?.send(BridgeProtocol.request(
            id = UUID.randomUUID().toString(),
            type = "session.snapshot",
            fields = mapOf("sessionRef" to sessionRef),
        ))
    }

    fun refreshSessions() {
        socket?.send(BridgeProtocol.request(UUID.randomUUID().toString(), "session.list"))
    }

    fun sendTurn(sessionRef: String, text: String) {
        socket?.send(BridgeProtocol.request(
            id = UUID.randomUUID().toString(),
            type = "turn.start",
            fields = mapOf("sessionRef" to sessionRef, "text" to text),
        ))
    }

    fun close() {
        socket?.close(1000, "Mobile client disconnecting")
        socket = null
    }

    private fun handle(webSocket: WebSocket, response: JSONObject) {
        BridgeProtocol.error(response)?.let {
            listener.onError(it)
            return
        }
        when (response.optString("type")) {
            "auth.ready" -> {
                listener.onConnectionChanged(ConnectionState.CONNECTED)
                webSocket.send(BridgeProtocol.request(UUID.randomUUID().toString(), "session.list"))
            }
            "event" -> {
                BridgeProtocol.parseSessions(response)?.let(listener::onSessions)
                BridgeProtocol.parseSnapshot(response)?.let { (session, items) ->
                    listener.onSnapshot(session, items)
                }
                BridgeProtocol.parseTurnItem(response)?.let(listener::onTurnItem)
                BridgeProtocol.parseTurnState(response)?.let(listener::onTurnState)
                BridgeProtocol.parseEventError(response)?.let(listener::onError)
            }
            "turn.end" -> listener.onTurnEnd()
        }
    }
}
