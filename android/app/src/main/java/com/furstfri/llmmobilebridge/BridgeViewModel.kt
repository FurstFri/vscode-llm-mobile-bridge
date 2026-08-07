package com.furstfri.llmmobilebridge

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import kotlinx.coroutines.flow.StateFlow

/**
 * A thin view over [BridgeRepository]. The sockets and the state deliberately
 * outlive this object: the foreground service keeps them running while the UI
 * is closed, so nothing is torn down when the Activity goes away.
 */
class BridgeViewModel(application: Application) : AndroidViewModel(application) {
    val state: StateFlow<BridgeUiState> = BridgeRepository.state

    init {
        BridgeRepository.initialize(application)
    }

    fun updatePairingText(value: String) = BridgeRepository.updatePairingText(value)

    fun beginAddHost() = BridgeRepository.beginAddHost()

    fun cancelAddHost() = BridgeRepository.cancelAddHost()

    fun pair() = BridgeRepository.pair()

    fun reconnect() = BridgeRepository.reconnect()

    fun reconnectIfNeeded() = BridgeRepository.reconnectIfNeeded()

    fun forgetHost(hostId: String) = BridgeRepository.forgetHost(hostId)

    fun unpair() = BridgeRepository.unpair()

    fun select(session: BridgeSession) = BridgeRepository.select(session)

    fun selectByRef(hostId: String, sessionRef: String): Boolean =
        BridgeRepository.selectByRef(hostId, sessionRef)

    fun startNewChat(hostId: String, provider: String) = BridgeRepository.startNewChat(hostId, provider)

    fun setTurnModel(value: String) = BridgeRepository.setTurnModel(value)

    fun setTurnEffort(value: String) = BridgeRepository.setTurnEffort(value)

    fun setTurnMode(value: String) = BridgeRepository.setTurnMode(value)

    fun closeTimeline() = BridgeRepository.closeTimeline()

    fun refresh() = BridgeRepository.refresh()

    fun refreshTimeline() = BridgeRepository.refreshTimeline()

    fun updateComposer(value: String) = BridgeRepository.updateComposer(value)

    fun sendMessage() = BridgeRepository.sendMessage()

    fun respondToApproval(id: String, allow: Boolean, choice: String? = null) =
        BridgeRepository.respondToApproval(id, allow, choice)

    fun discover() = BridgeRepository.discover()

    fun checkForUpdate(announceUpToDate: Boolean = false) =
        BridgeRepository.checkForUpdate(BuildConfig.VERSION_NAME, announceUpToDate)

    fun installUpdate() = BridgeRepository.installUpdate()

    fun dismissUpdate() = BridgeRepository.dismissUpdate()
}
