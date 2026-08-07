package com.furstfri.llmmobilebridge

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Owns the pairings, the sockets and the UI state for the whole process.
 *
 * This used to live inside the ViewModel, which tied the connections to the
 * Activity: closing the app dropped them, and a question raised on the
 * workstation went unanswered until the user happened to reopen the phone.
 * Holding it here lets [BridgeService] keep the same sockets alive with no UI
 * on screen, and keeps one client per paired machine either way.
 */
object BridgeRepository : BridgeClient.Listener {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutableState = MutableStateFlow(BridgeUiState())
    val state: StateFlow<BridgeUiState> = mutableState.asStateFlow()

    private var store: SecurePairingStore? = null
    private var updater: AppUpdater? = null
    private val client = BridgeClient(this)
    private var started = false

    /** Safe to call from every entry point; only the first call does the work. */
    fun initialize(context: Context) {
        if (started) return
        started = true
        val applicationContext = context.applicationContext
        val pairingStore = SecurePairingStore(applicationContext)
        store = pairingStore
        updater = AppUpdater(applicationContext)
        val pairings = pairingStore.load()
        if (pairings.isNotEmpty()) {
            mutableState.update { it.copy(pairings = pairings) }
            client.connectAll(pairings)
        }
    }

    fun updatePairingText(value: String) {
        mutableState.update { it.copy(pairingText = value, error = null) }
    }

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
        // Re-pairing the same machine replaces its entry instead of duplicating
        // it: by connection id when the machine sends one, by credentials for
        // pairings made before 0.13.0.
        val existing = state.value.pairings.firstOrNull { it.id == pairing.id }
            ?: state.value.pairings.firstOrNull { it.url == pairing.url && it.token == pairing.token }
        val stored = if (existing != null) pairing.copy(id = existing.id) else pairing
        val pairings = state.value.pairings.filterNot { it.id == stored.id } + stored
        store?.save(pairings)
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
        if (pairings.isEmpty()) store?.clear() else store?.save(pairings)
        mutableState.update { current ->
            current.copy(
                pairings = pairings,
                connections = current.connections - hostId,
                sessions = current.sessions.filterNot { it.hostId == hostId },
                providerStatus = current.providerStatus - hostId,
                pending = current.pending.filterNot { it.hostId == hostId },
                selectedSession = current.selectedSession?.takeIf { it.hostId != hostId },
                timeline = if (current.selectedSession?.hostId == hostId) emptyList() else current.timeline,
            )
        }
    }

    fun unpair() {
        client.closeAll()
        store?.clear()
        mutableState.value = BridgeUiState()
    }

    fun select(session: BridgeSession) {
        mutableState.update {
            it.copy(
                selectedSession = session,
                newChatHostId = null,
                newChatProvider = null,
                timeline = emptyList(),
                approvals = emptyList(),
                turnModel = "",
                turnEffort = "",
                turnMode = "",
                error = null,
            )
        }
        client.requestSnapshot(session.hostId, session.ref)
    }

    /** Opens the chat a notification pointed at, once its host has listed it. */
    fun selectByRef(hostId: String, sessionRef: String): Boolean {
        val session = state.value.sessions.firstOrNull { it.hostId == hostId && it.ref == sessionRef }
            ?: return false
        select(session)
        return true
    }

    fun startNewChat(hostId: String, provider: String) {
        mutableState.update {
            it.copy(
                selectedSession = null,
                newChatHostId = hostId,
                newChatProvider = provider,
                timeline = emptyList(),
                approvals = emptyList(),
                composerText = "",
                turnModel = "",
                turnEffort = "",
                turnMode = "",
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

    fun setTurnMode(value: String) {
        mutableState.update { it.copy(turnMode = value) }
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
            client.sendTurn(hostId, session.ref, text, current.turnModel, current.turnEffort, current.turnMode)
        } else {
            val provider = current.newChatProvider ?: return
            client.sendNewChat(hostId, provider, text, current.turnModel, current.turnEffort, current.turnMode)
        }
    }

    fun respondToApproval(id: String, allow: Boolean, choice: String? = null) {
        val current = state.value
        val hostId = current.selectedSession?.hostId ?: current.newChatHostId ?: return
        // Show the decision immediately; the machine confirms it right after.
        mutableState.update {
            it.copy(
                approvals = it.approvals.map { approval ->
                    if (approval.id == id) approval.copy(resolved = true, allowed = allow, answer = choice) else approval
                },
                pending = it.pending.filterNot { prompt -> prompt.approvalId == id },
            )
        }
        client.sendApproval(hostId, id, allow, choice)
    }

    /**
     * Broadcasts a probe and repairs the address of any paired machine that
     * moved. Only plain ws:// pairings are healed — see [NetworkDiscovery].
     */
    fun discover() {
        if (state.value.discovering) return
        mutableState.update { it.copy(discovering = true, error = null) }
        scope.launch {
            val hosts = withContext(Dispatchers.IO) { NetworkDiscovery.probe() }
            val healed = mutableListOf<PairingPayload>()
            val pairings = state.value.pairings.map { pairing ->
                val match = hosts.firstOrNull { it.connectionId == pairing.id } ?: return@map pairing
                if (!NetworkDiscovery.shouldHeal(pairing.url, match.url)) return@map pairing
                val updated = pairing.copy(url = match.url)
                healed += updated
                updated
            }
            if (healed.isNotEmpty()) {
                store?.save(pairings)
                mutableState.update { it.copy(pairings = pairings) }
                healed.forEach(client::connect)
            }
            mutableState.update { it.copy(discovered = hosts, discovering = false) }
        }
    }

    fun checkForUpdate(currentVersion: String, announceUpToDate: Boolean = false) {
        val appUpdater = updater ?: return
        appUpdater.check(
            currentVersion = currentVersion,
            onResult = { release ->
                scope.launch {
                    mutableState.update {
                        it.copy(
                            update = release,
                            updateStatus = when {
                                release != null -> null
                                announceUpToDate -> "Установлена последняя версия"
                                else -> it.updateStatus
                            },
                        )
                    }
                }
            },
            onError = { message ->
                scope.launch {
                    mutableState.update { it.copy(updateStatus = "Проверка обновления: $message") }
                }
            },
        )
    }

    /** Downloads the release and hands the APK to the platform installer. */
    fun installUpdate() {
        val appUpdater = updater ?: return
        val release = state.value.update ?: return
        if (!appUpdater.canInstall()) {
            mutableState.update { it.copy(updateStatus = "Разрешите установку из этого приложения") }
            appUpdater.requestInstallPermission()
            return
        }
        mutableState.update { it.copy(updateStatus = "Загрузка ${release.tag}…") }
        appUpdater.download(
            release = release,
            onDone = { file ->
                scope.launch {
                    val launched = appUpdater.install(file)
                    mutableState.update {
                        it.copy(updateStatus = if (launched) null else "Разрешите установку из этого приложения")
                    }
                }
            },
            onError = { message ->
                scope.launch { mutableState.update { it.copy(updateStatus = message) } }
            },
        )
    }

    fun dismissUpdate() {
        mutableState.update { it.copy(update = null, updateStatus = null) }
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

    override fun onApproval(hostId: String, approval: ApprovalRequest) = onUi {
        mutableState.update { current ->
            // Tracked for every machine, not only the open chat: the service
            // notifies about a prompt raised while the app was closed.
            val pending = current.pending.filterNot { it.approvalId == approval.id } +
                if (approval.resolved) emptyList() else listOf(pendingPrompt(current, hostId, approval))
            val onScreen = current.selectedSession?.hostId == hostId || current.newChatHostId == hostId
            if (!onScreen) return@update current.copy(pending = pending)
            val existing = current.approvals.indexOfFirst { it.id == approval.id }
            val approvals = if (existing >= 0) {
                current.approvals.toMutableList().also { it[existing] = approval }
            } else {
                current.approvals + approval
            }
            current.copy(approvals = approvals, pending = pending)
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

    private fun pendingPrompt(
        current: BridgeUiState,
        hostId: String,
        approval: ApprovalRequest,
    ): PendingPrompt = PendingPrompt(
        hostId = hostId,
        hostName = current.pairings.firstOrNull { it.id == hostId }?.name ?: "Компьютер",
        sessionRef = approval.sessionRef,
        approvalId = approval.id,
        kind = approval.kind,
        title = approval.question?.takeIf(String::isNotBlank)
            ?: approval.summary?.takeIf(String::isNotBlank)
            ?: approval.toolName,
    )

    private fun onUi(block: () -> Unit) {
        scope.launch { block() }
    }
}
