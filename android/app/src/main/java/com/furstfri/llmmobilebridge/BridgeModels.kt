package com.furstfri.llmmobilebridge

data class PairingPayload(
    val url: String,
    val token: String,
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
)

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
    val pairing: PairingPayload? = null,
    val connection: ConnectionState = ConnectionState.DISCONNECTED,
    val sessions: List<BridgeSession> = emptyList(),
    val selectedSession: BridgeSession? = null,
    /** Provider of a not-yet-created chat opened via "New chat". */
    val newChatProvider: String? = null,
    val timeline: List<TimelineItem> = emptyList(),
    val composerText: String = "",
    val turnModel: String = "",
    val turnEffort: String = "",
    val sending: Boolean = false,
    val error: String? = null,
)
