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
        val pairings = store.load()
        if (pairings.isNotEmpty()) {
            mutableState.update { it.copy(pairings = pairings) }
            client.connectAll(pairings)
        }
    }

    fun updatePairingText(value: String) {
        mutableState.update { it.copy(pairingText = value, error = null) }
    }

    /** Opens the pairing screen to add one more machine. */
    fun beginAddHost() {
        mutableState.update { it.copy(addingHost = true, pairingText = "", error = null) }
    }

    fun cancelAddHost() {
        mutableState.update { it.copy(addingHost = false, pairingText = "", error = null) }
    }

    fun pair() {
        val pairing = runCatching { BridgeProtocol.parsePairing(state.value.pairingText) }
            .getOrElse {
                mutableState.update { current -> current.copy(error = it.message ?: "Пейринг некорректен") }
                return
            }
        // Re-pairing the same machine replaces its entry instead of duplicating it.
        val existing = state.value.pairings.firstOrNull { it.url == pairing.url && it.token == pairing.token }
        val stored = if (existing != null) pairing.copy(id = existing.id) else pairing
        val pairings = state.value.pairings.filterNot { it.id == stored.id } + stored
        store.save(pairings)
        mutableState.update {
            it.copy(pairings = pairings, pairingText = "", addingHost = false, error = null)
        }
        client.connect(stored)
    }

    fun reconnect() {
        client.connectAll(state.value.pairings)
    }

    /** Reconnects machines that dropped; used on screen wake and retries. */
    fun reconnectIfNeeded() {
        val current = state.value
        current.pairings
            .filter { current.connections[it.id] != ConnectionState.CONNECTED }
            .forEach(client::connect)
    }

    /** Removes one machine; keeps the others paired. */
    fun forgetHost(hostId: String) {
        client.close(hostId)
        val pairings = state.value.pairings.filterNot { it.id == hostId }
        if (pairings.isEmpty()) store.clear() else store.save(pairings)
        mutableState.update { current ->
            current.copy(
                pairings = pairings,
                connections = current.connections - hostId,
                sessions = current.sessions.filterNot { it.hostId == hostId },
                providerStatus = current.providerStatus - hostId,
                selectedSession = current.selectedSession?.takeIf { it.hostId != hostId },
                timeline = if (current.selectedSession?.hostId == hostId) emptyList() else current.timeline,
            )
        }
    }

    fun unpair() {
        client.closeAll()
        store.clear()
        mutableState.value = BridgeUiState()
    }

    fun select(session: BridgeSession) {
        mutableState.update {
            it.copy(
                selectedSession = session,
                newChatHostId = null,
                newChatProvider = null,
                timeline = emptyList(),
                turnModel = "",
                turnEffort = "",
                error = null,
            )
        }
        client.requestSnapshot(session.hostId, session.ref)
    }

    fun startNewChat(hostId: String, provider: String) {
        mutableState.update {
            it.copy(
                selectedSession = null,
                newChatHostId = hostId,
                newChatProvider = provider,
                timeline = emptyList(),
                composerText = "",
                turnModel = "",
                turnEffort = "",
                sending = false,
                error = null,
            )
        }
    }

    fun setTurnModel(value: String) {
        mutableState.update { it.copy(turnModel = value) }
    }

    fun setTurnEffort(value: String) {
        mutableState.update { it.copy(turnEffort = value) }
    }

    fun closeTimeline() {
        mutableState.update {
            it.copy(selectedSession = null, newChatHostId = null, newChatProvider = null, timeline = emptyList())
        }
    }

    fun refresh() {
        client.refreshAllSessions()
    }

    /** Re-requests the open chat's snapshot; used by the UI poller. */
    fun refreshTimeline() {
        val current = state.value
        val session = current.selectedSession ?: return
        if (current.connections[session.hostId] != ConnectionState.CONNECTED) return
        client.requestSnapshot(session.hostId, session.ref)
    }

    fun updateComposer(value: String) {
        mutableState.update { it.copy(composerText = value) }
    }

    fun sendMessage() {
        val current = state.value
        val text = current.composerText.trim()
        if (text.isEmpty() || current.sending) return
        val session = current.selectedSession
        val hostId = session?.hostId ?: current.newChatHostId ?: return
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
        if (session != null) {
            client.sendTurn(hostId, session.ref, text, current.turnModel, current.turnEffort)
        } else {
            val provider = current.newChatProvider ?: return
            client.sendNewChat(hostId, provider, text, current.turnModel, current.turnEffort)
        }
    }

    override fun onConnectionChanged(hostId: String, state: ConnectionState) = onUi {
        mutableState.update { it.copy(connections = it.connections + (hostId to state)) }
    }

    override fun onSessions(hostId: String, sessions: List<BridgeSession>) = onUi {
        mutableState.update { current ->
            // Replace only this machine's slice; other machines keep theirs.
            current.copy(sessions = current.sessions.filterNot { it.hostId == hostId } + sessions, error = null)
        }
    }

    override fun onProviderStatus(hostId: String, statuses: List<ProviderStatus>) = onUi {
        mutableState.update { current ->
            current.copy(
                providerStatus = current.providerStatus + (hostId to statuses.associateBy { it.provider }),
            )
        }
    }

    override fun onSnapshot(hostId: String, session: BridgeSession, items: List<TimelineItem>) = onUi {
        mutableState.update { current ->
            val open = current.selectedSession
            if (open?.hostId != hostId || open.ref != session.ref) return@update current
            // While our own turn is in flight, keep the optimistic timeline.
            if (current.sending) return@update current
            current.copy(selectedSession = session, timeline = items, error = null)
        }
    }

    override fun onSessionCreated(hostId: String, session: BridgeSession) = onUi {
        mutableState.update { current ->
            if (current.newChatHostId == hostId && current.newChatProvider == session.provider) {
                current.copy(
                    selectedSession = session,
                    newChatHostId = null,
                    newChatProvider = null,
                    sessions = current.sessions + session,
                )
            } else {
                current
            }
        }
    }

    override fun onTurnItem(hostId: String, item: TimelineItem) = onUi {
        mutableState.update { current ->
            if (current.selectedSession?.hostId != hostId && current.newChatHostId != hostId) return@update current
            val existing = current.timeline.indexOfFirst { it.id == item.id }
            val timeline = if (existing >= 0) {
                current.timeline.toMutableList().also { it[existing] = item }
            } else {
                current.timeline + item
            }
            current.copy(timeline = timeline)
        }
    }

    override fun onTurnState(hostId: String, state: String) = onUi {
        mutableState.update { current ->
            val open = current.selectedSession ?: return@update current
            if (open.hostId != hostId) return@update current
            current.copy(selectedSession = open.copy(state = state))
        }
    }

    override fun onTurnEnd(hostId: String) = onUi {
        mutableState.update { it.copy(sending = false) }
        val session = state.value.selectedSession
        if (session != null && session.hostId == hostId) client.requestSnapshot(hostId, session.ref)
        // Usage moved during the turn — refresh the numbers we show.
        client.requestProviderStatus(hostId)
    }

    override fun onError(hostId: String, message: String) = onUi {
        val name = state.value.pairings.firstOrNull { it.id == hostId }?.name
        mutableState.update {
            it.copy(error = if (name != null) "$name: $message" else message, sending = false)
        }
    }

    override fun onCleared() {
        client.closeAll()
        super.onCleared()
    }

    private fun onUi(block: () -> Unit) {
        viewModelScope.launch { block() }
    }
}
