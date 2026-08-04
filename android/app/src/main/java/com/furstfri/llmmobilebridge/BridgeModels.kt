package com.furstfri.llmmobilebridge

import java.util.UUID

/** One paired machine: a relay/gateway URL plus its pairing token. */
data class PairingPayload(
    val url: String,
    val token: String,
    val name: String = "Компьютер",
    val id: String = UUID.randomUUID().toString(),
)

data class SessionCapabilities(
    val canRead: Boolean,
    val canStartTurn: Boolean,
    val canApprove: Boolean,
)

data class BridgeSession(
    val ref: String,
    val provider: String,
    val title: String,
    val state: String,
    val project: String? = null,
    val updatedAt: Long? = null,
    val capabilities: SessionCapabilities,
    /** Which paired machine this session lives on; filled in by the client. */
    val hostId: String = "",
    val hostName: String = "",
) {
    /** Unique across machines — two hosts can mint the same session ref. */
    val key: String get() = "$hostId/$ref"
}

data class TimelineItem(
    val id: String,
    val kind: String,
    val role: String?,
    val text: String,
    val status: String?,
    val at: Long? = null,
)

enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    AUTHENTICATING,
    CONNECTED,
}

data class BridgeUiState(
    val pairingText: String = "",
    /** Every paired machine; empty means the app is not set up yet. */
    val pairings: List<PairingPayload> = emptyList(),
    /** Connection state per machine, keyed by pairing id. */
    val connections: Map<String, ConnectionState> = emptyMap(),
    /** True while the pairing screen is shown to add another machine. */
    val addingHost: Boolean = false,
    val sessions: List<BridgeSession> = emptyList(),
    val selectedSession: BridgeSession? = null,
    /** Machine a not-yet-created chat belongs to, with its provider. */
    val newChatHostId: String? = null,
    val newChatProvider: String? = null,
    val timeline: List<TimelineItem> = emptyList(),
    val composerText: String = "",
    val turnModel: String = "",
    val turnEffort: String = "",
    val sending: Boolean = false,
    val error: String? = null,
) {
    /** Worst state across machines, for the header summary. */
    val overallConnection: ConnectionState
        get() = when {
            connections.isEmpty() -> ConnectionState.DISCONNECTED
            connections.values.any { it == ConnectionState.CONNECTED } -> ConnectionState.CONNECTED
            connections.values.any { it == ConnectionState.AUTHENTICATING } -> ConnectionState.AUTHENTICATING
            connections.values.any { it == ConnectionState.CONNECTING } -> ConnectionState.CONNECTING
            else -> ConnectionState.DISCONNECTED
        }

    val connectedCount: Int get() = connections.values.count { it == ConnectionState.CONNECTED }
}
