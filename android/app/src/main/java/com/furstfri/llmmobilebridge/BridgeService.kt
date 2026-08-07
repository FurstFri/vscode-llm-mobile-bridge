package com.furstfri.llmmobilebridge

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps the paired sockets alive while the UI is closed, so a question or an
 * approval raised on the workstation still reaches the phone. Everything stays
 * on the device — there is no push server in the loop.
 */
class BridgeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val shown = mutableSetOf<String>()

    override fun onCreate() {
        super.onCreate()
        BridgeNotifications.ensureChannels(this)
        BridgeRepository.initialize(this)
        scope.launch {
            BridgeRepository.state.collect { state -> render(state) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundStatus(BridgeRepository.state.value)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        shown.forEach { BridgeNotifications.cancel(this, it.hashCode()) }
        shown.clear()
        scope.cancel()
        super.onDestroy()
    }

    private fun render(state: BridgeUiState) {
        startForegroundStatus(state)
        val open = state.pending.associateBy { it.approvalId }
        for (prompt in state.pending) {
            if (!shown.add(prompt.approvalId)) continue
            BridgeNotifications.post(this, BridgeNotifications.notificationId(prompt), BridgeNotifications.prompt(this, prompt))
        }
        // Answering on the phone, or the machine timing the prompt out, clears it.
        shown.filterNot(open::containsKey).forEach { approvalId ->
            shown.remove(approvalId)
            BridgeNotifications.cancel(this, approvalId.hashCode())
        }
    }

    private fun startForegroundStatus(state: BridgeUiState) {
        val notification = BridgeNotifications.status(
            context = this,
            connected = state.connectedCount,
            total = state.pairings.size,
            pending = state.pending.size,
        )
        ServiceCompat.startForeground(
            this,
            BridgeNotifications.STATUS_NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
    }

    companion object {
        const val ACTION_STOP = "com.furstfri.llmmobilebridge.STOP"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, BridgeService::class.java))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, BridgeService::class.java).setAction(ACTION_STOP))
        }
    }
}
