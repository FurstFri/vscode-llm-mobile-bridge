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

    override fun onConnectionChanged(state: ConnectionState) = onUi {
        mutableState.update { it.copy(connection = state) }
    }

    override fun onSessions(sessions: List<BridgeSession>) = onUi {
        mutableState.update { it.copy(sessions = sessions, error = null) }
    }

    override fun onSnapshot(session: BridgeSession, items: List<TimelineItem>) = onUi {
        mutableState.update { current ->
            current.copy(
                selectedSession = session.takeIf { current.selectedSession?.ref == session.ref },
                timeline = items,
                error = null,
            )
        }
    }

    override fun onError(message: String) = onUi {
        mutableState.update { it.copy(error = message) }
    }

    override fun onCleared() {
        client.close()
        super.onCleared()
    }

    private fun onUi(block: () -> Unit) {
        viewModelScope.launch { block() }
    }
}
