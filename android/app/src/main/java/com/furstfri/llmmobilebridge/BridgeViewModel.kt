package com.furstfri.llmmobilebridge

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class BridgeViewModel(application: Application) : AndroidViewModel(application), BridgeClient.Listener {
    private val store = SecurePairingStore(application)
    private val client = BridgeClient(this)
    private val mutableState = MutableStateFlow(BridgeUiState())
    val state: StateFlow<BridgeUiState> = mutableState.asStateFlow()

    init {
        store.load()?.let { pairing ->
            mutableState.update { it.copy(pairing = pairing) }
            client.connect(pairing)
        }
    }

    fun updatePairingText(value: String) {
        mutableState.update { it.copy(pairingText = value, error = null) }
    }

    fun pair() {
        val pairing = runCatching { BridgeProtocol.parsePairing(state.value.pairingText) }
            .getOrElse {
                mutableState.update { current -> current.copy(error = it.message ?: "Pairing payload is invalid") }
                return
            }
        store.save(pairing)
        mutableState.update { it.copy(pairing = pairing, pairingText = "", error = null) }
        client.connect(pairing)
    }

    fun reconnect() {
        state.value.pairing?.let(client::connect)
    }

    /** Reconnects after screen wake or network loss; no-op when already connected. */
    fun reconnectIfNeeded() {
        val current = state.value
        if (current.pairing != null && current.connection == ConnectionState.DISCONNECTED) {
            client.connect(current.pairing)
        }
    }

    fun unpair() {
        client.close()
        store.clear()
        mutableState.value = BridgeUiState()
    }

    fun select(session: BridgeSession) {
        mutableState.update { it.copy(selectedSession = session, timeline = emptyList(), error = null) }
        client.requestSnapshot(session.ref)
    }

    fun closeTimeline() {
        mutableState.update { it.copy(selectedSession = null, timeline = emptyList()) }
    }

    fun refresh() {
        client.refreshSessions()
    }

    /** Re-requests the open chat's snapshot; used by the UI poller. */
    fun refreshTimeline() {
        val current = state.value
        if (current.connection != ConnectionState.CONNECTED) return
        current.selectedSession?.let { client.requestSnapshot(it.ref) }
    }

    fun updateComposer(value: String) {
        mutableState.update { it.copy(composerText = value) }
    }

    fun sendMessage() {
        val current = state.value
        val session = current.selectedSession ?: return
        val text = current.composerText.trim()
        if (text.isEmpty() || current.sending) return
        val optimistic = TimelineItem(
            id = "local-${System.currentTimeMillis()}",
            kind = "message",
            role = "user",
            text = text,
            status = "pending",
            at = System.currentTimeMillis(),
        )
        mutableState.update {
            it.copy(
                composerText = "",
                sending = true,
                timeline = it.timeline + optimistic,
                error = null,
            )
        }
        client.sendTurn(session.ref, text)
    }

    override fun onConnectionChanged(state: ConnectionState) = onUi {
        mutableState.update { it.copy(connection = state) }
    }

    override fun onSessions(sessions: List<BridgeSession>) = onUi {
        mutableState.update { it.copy(sessions = sessions, error = null) }
    }

    override fun onSnapshot(session: BridgeSession, items: List<TimelineItem>) = onUi {
        mutableState.update { current ->
            // While our own turn is in flight, keep the optimistic timeline —
            // a background poll must not wipe the pending message.
            if (current.sending && current.selectedSession?.ref == session.ref) return@update current
            current.copy(
                selectedSession = session.takeIf { current.selectedSession?.ref == session.ref },
                timeline = items,
                error = null,
            )
        }
    }

    override fun onTurnItem(item: TimelineItem) = onUi {
        mutableState.update { current ->
            val existing = current.timeline.indexOfFirst { it.id == item.id }
            val timeline = if (existing >= 0) {
                current.timeline.toMutableList().also { it[existing] = item }
            } else {
                current.timeline + item
            }
            current.copy(timeline = timeline)
        }
    }

    override fun onTurnState(state: String) = onUi {
        mutableState.update { current ->
            current.copy(selectedSession = current.selectedSession?.copy(state = state))
        }
    }

    override fun onTurnEnd() = onUi {
        mutableState.update { it.copy(sending = false) }
        state.value.selectedSession?.let { client.requestSnapshot(it.ref) }
    }

    override fun onError(message: String) = onUi {
        mutableState.update { it.copy(error = message, sending = false) }
    }

    override fun onCleared() {
        client.close()
        super.onCleared()
    }

    private fun onUi(block: () -> Unit) {
        viewModelScope.launch { block() }
    }
}
