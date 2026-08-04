package com.furstfri.llmmobilebridge

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** VS Code Dark Modern palette with the Claude/Codex accents. */
private object Vs {
    val Background = Color(0xFF1E1E1E)
    val Panel = Color(0xFF181818)
    val Surface = Color(0xFF252526)
    val SurfaceRaised = Color(0xFF2D2D30)
    val Border = Color(0xFF3C3C3C)
    val Foreground = Color(0xFFCCCCCC)
    val Dim = Color(0xFF9D9D9D)
    val Faint = Color(0xFF6E6E6E)
    val Claude = Color(0xFFD97757)
    val Codex = Color(0xFF10A37F)
    val Ok = Color(0xFF89D185)
    val Warn = Color(0xFFCCA700)
    val Err = Color(0xFFF48771)
    val UserBlock = Color(0xFF2A2D2E)
}

private val BridgeColors = darkColorScheme(
    primary = Vs.Claude,
    onPrimary = Color(0xFF1E1E1E),
    background = Vs.Background,
    surface = Vs.Panel,
    surfaceVariant = Vs.Surface,
    onSurface = Vs.Foreground,
    onSurfaceVariant = Vs.Dim,
    outline = Vs.Border,
    error = Vs.Err,
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // FLAG_SECURE intentionally not set: screenshots and screen recording
        // are allowed by user request.
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = BridgeColors) {
                val model: BridgeViewModel = viewModel()
                val state by model.state.collectAsState()
                BridgeScreen(state, model)
            }
        }
    }
}

@Composable
private fun BridgeScreen(state: BridgeUiState, model: BridgeViewModel) {
    // Reconnect immediately when the screen wakes up / the app returns to
    // the foreground — the socket usually dies while the phone is locked.
    LifecycleResumeEffect(Unit) {
        model.reconnectIfNeeded()
        onPauseOrDispose { }
    }
    // Background retry loop: while paired but disconnected, keep trying.
    LaunchedEffect(state.connections, state.pairings) {
        if (state.pairings.isNotEmpty() && state.connectedCount < state.pairings.size) {
            delay(5_000)
            model.reconnectIfNeeded()
        }
    }
    Scaffold(containerColor = MaterialTheme.colorScheme.background) { padding ->
        when {
            state.pairings.isEmpty() || state.addingHost -> PairingScreen(state, model, padding)
            state.selectedSession != null || state.newChatProvider != null ->
                TimelineScreen(state, model, padding)
            else -> SessionsScreen(state, model, padding)
        }
    }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

@Composable
private fun PairingScreen(state: BridgeUiState, model: BridgeViewModel, padding: PaddingValues) {
    Column(
        modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(Vs.Claude, 10.dp)
            Spacer(Modifier.width(10.dp))
            Text(
                if (state.addingHost) "Добавить компьютер" else "LLM Bridge",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "В VS Code откройте панель LLM Bridge и выполните «Скопировать пейринг для телефона», затем вставьте JSON сюда."
                + if (state.addingHost) " Так можно подключить и удалённый сервер, открытый через Remote-SSH." else "",
            color = Vs.Dim,
            fontSize = 13.sp,
        )
        if (state.pairings.isNotEmpty()) {
            Spacer(Modifier.height(14.dp))
            state.pairings.forEach { pairing ->
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StatusDot(connectionColor(state.connections[pairing.id] ?: ConnectionState.DISCONNECTED), 7.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(pairing.name, color = Vs.Foreground, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Text(
                        "убрать",
                        color = Vs.Faint,
                        fontSize = 12.sp,
                        modifier = Modifier
                            .clickable { model.forgetHost(pairing.id) }
                            .padding(horizontal = 6.dp, vertical = 4.dp),
                    )
                }
            }
        }
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(
            value = state.pairingText,
            onValueChange = model::updatePairingText,
            modifier = Modifier.fillMaxWidth(),
            minLines = 4,
            textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            placeholder = { Text("{\"protocolVersion\":1,\"url\":\"wss://…\",\"token\":\"…\"}", color = Vs.Faint, fontSize = 12.sp, fontFamily = FontFamily.Monospace) },
            colors = vsFieldColors(),
            shape = RoundedCornerShape(6.dp),
        )
        state.error?.let { ErrorText(it) }
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = model::pair,
                enabled = state.pairingText.isNotBlank(),
                shape = RoundedCornerShape(4.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Vs.Claude, contentColor = Color(0xFF1E1E1E)),
            ) {
                Text("Подключить", fontWeight = FontWeight.SemiBold)
            }
            if (state.addingHost) {
                OutlinedButton(onClick = model::cancelAddHost, shape = RoundedCornerShape(4.dp)) {
                    Text("Отмена", color = Vs.Dim)
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

private val ProviderPages = listOf(
    Triple("CLAUDE CODE", "claude", Vs.Claude),
    Triple("CODEX", "codex", Vs.Codex),
)

@Composable
private fun SessionsScreen(state: BridgeUiState, model: BridgeViewModel, padding: PaddingValues) {
    // Keep the list fresh while the screen is open.
    LaunchedEffect(Unit) {
        while (true) {
            delay(15_000)
            model.refresh()
        }
    }
    val pagerState = rememberPagerState(pageCount = { ProviderPages.size })
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().padding(padding)) {
        PanelHeader(
            title = "LLM Bridge",
            subtitle = if (state.pairings.size > 1) {
                "${connectionLabel(state.overallConnection)} · ${state.connectedCount} из ${state.pairings.size}"
            } else {
                connectionLabel(state.overallConnection)
            },
            statusColor = connectionColor(state.overallConnection),
            action = "Обновить" to model::refresh,
        )
        // Top tab strip, VS Code panel style; swipe or tap to switch provider.
        TabRow(
            selectedTabIndex = pagerState.currentPage,
            containerColor = Vs.Panel,
            contentColor = Vs.Foreground,
            indicator = { tabPositions ->
                TabRowDefaults.SecondaryIndicator(
                    Modifier.tabIndicatorOffset(tabPositions[pagerState.currentPage]),
                    color = ProviderPages[pagerState.currentPage].third,
                )
            },
            divider = { HorizontalDivider(color = Vs.Border, thickness = 1.dp) },
        ) {
            ProviderPages.forEachIndexed { index, (label, _, accent) ->
                Tab(
                    selected = pagerState.currentPage == index,
                    onClick = { scope.launch { pagerState.animateScrollToPage(index) } },
                    text = {
                        Text(
                            label,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = if (pagerState.currentPage == index) accent else Vs.Faint,
                        )
                    },
                )
            }
        }
        state.error?.let { ErrorText(it, Modifier.padding(horizontal = 16.dp)) }
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.connectedCount < state.pairings.size) {
                Button(
                    onClick = model::reconnect,
                    shape = RoundedCornerShape(4.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Vs.Claude, contentColor = Color(0xFF1E1E1E)),
                ) { Text("Переподключить") }
            }
            OutlinedButton(onClick = model::beginAddHost, shape = RoundedCornerShape(4.dp)) {
                Text("+ Компьютер", color = Vs.Dim, fontSize = 13.sp)
            }
        }
        HorizontalPager(
            state = pagerState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) { page ->
            val (label, provider, accent) = ProviderPages[page]
            val sessions = state.sessions
                .filter { it.provider == provider }
                .sortedByDescending { it.updatedAt ?: 0L }
            val showHostNames = state.pairings.size > 1
            LazyColumn(Modifier.fillMaxSize()) {
                // One "new chat" entry per machine, so the target is unambiguous.
                items(state.pairings, key = { "new/${it.id}" }) { pairing ->
                    NewChatRow(
                        accent = accent,
                        hostName = if (showHostNames) pairing.name else null,
                        enabled = state.connections[pairing.id] == ConnectionState.CONNECTED,
                    ) { model.startNewChat(pairing.id, provider) }
                    HorizontalDivider(color = Vs.Surface, thickness = 1.dp)
                }
                items(sessions, key = BridgeSession::key) { session ->
                    SessionRow(session, showHostNames) { model.select(session) }
                    HorizontalDivider(color = Vs.Surface, thickness = 1.dp)
                }
                if (sessions.isEmpty() && state.overallConnection == ConnectionState.CONNECTED) {
                    item {
                        Text(
                            "Сессий $label нет — начните новый чат сверху.",
                            modifier = Modifier.padding(16.dp),
                            color = Vs.Dim,
                            fontSize = 13.sp,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun NewChatRow(accent: Color, hostName: String?, enabled: Boolean, onClick: () -> Unit) {
    val color = if (enabled) accent else Vs.Faint
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(18.dp).border(1.dp, color, RoundedCornerShape(5.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text("+", color = color, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(10.dp))
        Text("Новый чат", color = color, fontSize = 14.sp, fontWeight = FontWeight.Medium)
        if (hostName != null) {
            Spacer(Modifier.width(6.dp))
            Text("на $hostName", color = Vs.Faint, fontSize = 12.sp, maxLines = 1)
        }
        if (!enabled) {
            Spacer(Modifier.weight(1f))
            Text("нет связи", color = Vs.Faint, fontSize = 11.sp)
        }
    }
}

@Composable
private fun SessionRow(session: BridgeSession, showHostName: Boolean, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(providerColor(session.provider), 7.dp)
            Spacer(Modifier.width(8.dp))
            Text(
                session.title,
                fontSize = 14.sp,
                color = Vs.Foreground,
                maxLines = 1,
                modifier = Modifier.weight(1f),
            )
            if (session.state == "busy") {
                Text("работает…", color = Vs.Warn, fontSize = 11.sp)
            }
        }
        Spacer(Modifier.height(3.dp))
        val meta = listOfNotNull(
            if (showHostName) session.hostName.takeIf(String::isNotBlank) else null,
            providerLabel(session.provider),
            session.project,
            formatWhen(session.updatedAt),
            if (!session.capabilities.canStartTurn) "только чтение" else null,
        )
        Text(meta.joinToString("  ·  "), color = Vs.Faint, fontSize = 12.sp, maxLines = 1, modifier = Modifier.padding(start = 15.dp))
    }
}

// ---------------------------------------------------------------------------
// Timeline (chat)
// ---------------------------------------------------------------------------

@Composable
private fun TimelineScreen(state: BridgeUiState, model: BridgeViewModel, padding: PaddingValues) {
    val session = state.selectedSession
    val provider = session?.provider ?: state.newChatProvider ?: return
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    val listState = rememberLazyListState()
    var firstLoad by remember { mutableStateOf(true) }

    // Live updates: the gateway is pull-based, so poll the open chat's
    // snapshot — turns driven from VS Code appear on the phone too.
    LaunchedEffect(session?.ref) {
        if (session == null) return@LaunchedEffect
        while (true) {
            delay(5_000)
            model.refreshTimeline()
        }
    }

    // Open at the newest message: jump instantly on the first snapshot,
    // then follow new items only when the reader is already near the bottom.
    LaunchedEffect(state.timeline.size) {
        if (state.timeline.isEmpty()) return@LaunchedEffect
        if (firstLoad) {
            listState.scrollToItem(state.timeline.lastIndex)
            firstLoad = false
        } else {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            if (lastVisible >= state.timeline.lastIndex - 2) {
                listState.animateScrollToItem(state.timeline.lastIndex)
            }
        }
    }

    val lastActivity = maxOf(
        session?.updatedAt ?: 0L,
        state.timeline.maxOfOrNull { it.at ?: 0L } ?: 0L,
    ).takeIf { it > 0L }
    val hostName = session?.hostName?.takeIf(String::isNotBlank)
        ?: state.pairings.firstOrNull { it.id == state.newChatHostId }?.name
    Column(Modifier.fillMaxSize().padding(padding)) {
        PanelHeader(
            title = session?.title ?: "Новый чат",
            subtitle = listOfNotNull(
                hostName?.takeIf { state.pairings.size > 1 },
                providerLabel(provider),
                session?.project,
                session?.state ?: if (state.sending) "создаётся…" else "не начат",
                lastActivity?.let { "обновлено ${formatWhen(it)}" },
            ).joinToString(" · "),
            statusColor = providerColor(provider),
            action = "‹ Назад" to model::closeTimeline,
        )
        state.error?.let { ErrorText(it, Modifier.padding(horizontal = 16.dp)) }
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (session == null && state.timeline.isEmpty()) {
                item {
                    Text(
                        "Новый чат ${providerLabel(provider)}"
                            + (hostName?.let { " на $it" } ?: "")
                            + ". Напишите первое сообщение — сессия будет создана в рабочей папке VS Code.",
                        color = Vs.Dim,
                        fontSize = 13.sp,
                        lineHeight = 18.sp,
                    )
                }
            }
            items(state.timeline, key = TimelineItem::id) { item ->
                TimelineEntry(
                    item = item,
                    expanded = expanded[item.id] == true,
                    onToggle = { expanded[item.id] = !(expanded[item.id] ?: false) },
                )
            }
        }
        if (session?.capabilities?.canStartTurn != false) {
            Composer(state, model)
        } else {
            HorizontalDivider(color = Vs.Border, thickness = 1.dp)
            Text(
                "Только чтение: отправка отключена в настройках шлюза.",
                modifier = Modifier.fillMaxWidth().background(Vs.Panel).padding(14.dp),
                color = Vs.Dim,
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun TimelineEntry(item: TimelineItem, expanded: Boolean, onToggle: () -> Unit) {
    when {
        item.kind == "message" && item.role == "user" -> UserMessage(item)
        item.kind == "message" -> AssistantMessage(item)
        item.kind == "reasoning" -> ReasoningEntry(item, expanded, onToggle)
        else -> ToolEntry(item, expanded, onToggle)
    }
}

/** User message: bordered block, like the prompt blocks in the Claude Code panel. */
@Composable
private fun UserMessage(item: TimelineItem) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Vs.UserBlock, RoundedCornerShape(6.dp))
            .border(1.dp, Vs.Border, RoundedCornerShape(6.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(item.text.ifBlank { item.status ?: "" }, color = Vs.Foreground, fontSize = 14.sp, lineHeight = 20.sp)
        item.at?.let {
            Spacer(Modifier.height(4.dp))
            Text(formatClock(it), color = Vs.Faint, fontSize = 10.sp, modifier = Modifier.align(Alignment.End))
        }
    }
}

/** Assistant message: plain flowing text with the coral bullet, no bubble. */
@Composable
private fun AssistantMessage(item: TimelineItem) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 2.dp)) {
        Text("⏺", color = Vs.Claude, fontSize = 13.sp)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(
                item.text.ifBlank { item.status ?: "" },
                color = Vs.Foreground,
                fontSize = 14.sp,
                lineHeight = 20.sp,
            )
            item.at?.let {
                Spacer(Modifier.height(2.dp))
                Text(formatClock(it), color = Vs.Faint, fontSize = 10.sp)
            }
        }
    }
}

/** Reasoning: dimmed, collapsed by default. */
@Composable
private fun ReasoningEntry(item: TimelineItem, expanded: Boolean, onToggle: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(horizontal = 2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("✳", color = Vs.Faint, fontSize = 12.sp)
            Spacer(Modifier.width(8.dp))
            Text(
                "Размышления",
                color = Vs.Faint,
                fontSize = 12.sp,
                fontStyle = FontStyle.Italic,
                modifier = Modifier.weight(1f),
            )
            Text(if (expanded) "▾" else "▸", color = Vs.Faint, fontSize = 12.sp)
        }
        if (expanded) {
            Text(
                item.text,
                color = Vs.Dim,
                fontSize = 12.sp,
                lineHeight = 17.sp,
                fontStyle = FontStyle.Italic,
                modifier = Modifier.padding(start = 18.dp, top = 4.dp),
            )
        }
    }
}

/** Tool call: compact status row, output expands under a left rule. */
@Composable
private fun ToolEntry(item: TimelineItem, expanded: Boolean, onToggle: () -> Unit) {
    val label = item.text.lineSequence().firstOrNull().orEmpty().ifBlank { "tool" }
    val output = item.text.substringAfter("\n", missingDelimiterValue = "").trim()
    Column(Modifier.fillMaxWidth().clickable(enabled = output.isNotEmpty(), onClick = onToggle).padding(horizontal = 2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(toolStatusColor(item.status), 7.dp)
            Spacer(Modifier.width(8.dp))
            Text(
                label,
                color = Vs.Dim,
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                modifier = Modifier.weight(1f),
            )
            if (output.isNotEmpty()) Text(if (expanded) "▾" else "▸", color = Vs.Faint, fontSize = 12.sp)
        }
        if (expanded && output.isNotEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 15.dp, top = 6.dp)
                    .background(Vs.Panel, RoundedCornerShape(4.dp))
                    .border(1.dp, Vs.Surface, RoundedCornerShape(4.dp))
                    .padding(10.dp),
            ) {
                Text(
                    output,
                    color = Vs.Dim,
                    fontSize = 11.sp,
                    lineHeight = 15.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

/** Model choices per provider; the empty value means "provider default". */
private val ClaudeModels = listOf(
    "" to "модель по умолчанию",
    "opus" to "Opus",
    "sonnet" to "Sonnet",
    "haiku" to "Haiku",
)

private val CodexModels = listOf(
    "" to "модель по умолчанию",
    "gpt-5.1-codex-max" to "GPT-5.1 Codex Max",
    "gpt-5.1-codex" to "GPT-5.1 Codex",
    "gpt-5.1" to "GPT-5.1",
)

/** Thinking / effort levels; "off" disables extended thinking. */
private val EffortLevels = listOf(
    "" to "размышление: авто",
    "off" to "размышление: выкл",
    "low" to "размышление: low",
    "medium" to "размышление: medium",
    "high" to "размышление: high",
    "xhigh" to "размышление: xhigh",
    "max" to "размышление: max",
)

private fun modelsFor(provider: String) = if (provider == "codex") CodexModels else ClaudeModels

private fun shortLabel(options: List<Pair<String, String>>, value: String, fallback: String): String =
    options.firstOrNull { it.first == value }?.second?.substringAfter(": ")?.takeIf { value.isNotEmpty() } ?: fallback

/** Composer modeled on the Claude Code panel: accent-bordered box with a
 *  text area on top and the model / thinking / send controls below. */
@Composable
private fun Composer(state: BridgeUiState, model: BridgeViewModel) {
    val provider = state.selectedSession?.provider ?: state.newChatProvider ?: "claude"
    val accent = providerColor(provider)
    val canSend = !state.sending && state.composerText.isNotBlank()
    var modelMenu by remember { mutableStateOf(false) }
    var effortMenu by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .background(Vs.Panel)
            .padding(horizontal = 10.dp, vertical = 8.dp)
            .imePadding(),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(Vs.Surface, RoundedCornerShape(10.dp))
                .border(1.dp, if (state.sending) Vs.Border else accent, RoundedCornerShape(10.dp)),
        ) {
            OutlinedTextField(
                value = state.composerText,
                onValueChange = model::updateComposer,
                modifier = Modifier.fillMaxWidth(),
                placeholder = {
                    Text(
                        if (state.sending) "Агент отвечает…" else "Напишите сообщение агенту…",
                        color = Vs.Faint,
                        fontSize = 13.sp,
                    )
                },
                enabled = !state.sending,
                maxLines = 5,
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Color.Transparent,
                    unfocusedBorderColor = Color.Transparent,
                    disabledBorderColor = Color.Transparent,
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent,
                    cursorColor = accent,
                    focusedTextColor = Vs.Foreground,
                    unfocusedTextColor = Vs.Foreground,
                ),
            )
            Row(
                Modifier.fillMaxWidth().padding(start = 10.dp, end = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val models = modelsFor(provider)
                Box {
                    ComposerChip(
                        label = shortLabel(models, state.turnModel, "модель"),
                        enabled = !state.sending,
                        accent = if (state.turnModel.isNotEmpty()) accent else null,
                    ) { modelMenu = true }
                    DropdownMenu(
                        expanded = modelMenu,
                        onDismissRequest = { modelMenu = false },
                        containerColor = Vs.SurfaceRaised,
                    ) {
                        models.forEach { (value, label) ->
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        label,
                                        fontSize = 13.sp,
                                        color = if (state.turnModel == value) accent else Vs.Foreground,
                                    )
                                },
                                onClick = { model.setTurnModel(value); modelMenu = false },
                            )
                        }
                    }
                }
                Spacer(Modifier.width(8.dp))
                Box {
                    ComposerChip(
                        label = shortLabel(EffortLevels, state.turnEffort, "размышление"),
                        enabled = !state.sending,
                        accent = if (state.turnEffort.isNotEmpty()) accent else null,
                    ) { effortMenu = true }
                    DropdownMenu(
                        expanded = effortMenu,
                        onDismissRequest = { effortMenu = false },
                        containerColor = Vs.SurfaceRaised,
                    ) {
                        EffortLevels.forEach { (value, label) ->
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        label,
                                        fontSize = 13.sp,
                                        color = if (state.turnEffort == value) accent else Vs.Foreground,
                                    )
                                },
                                onClick = { model.setTurnEffort(value); effortMenu = false },
                            )
                        }
                    }
                }
                Spacer(Modifier.weight(1f))
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .background(if (canSend) accent else Vs.SurfaceRaised, RoundedCornerShape(8.dp))
                        .clickable(enabled = canSend, onClick = model::sendMessage),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("↑", color = if (canSend) Color(0xFF1E1E1E) else Vs.Faint, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
private fun ComposerChip(label: String, enabled: Boolean, accent: Color? = null, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .border(1.dp, accent ?: Vs.Border, RoundedCornerShape(6.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            color = accent ?: if (enabled) Vs.Dim else Vs.Faint,
            fontSize = 11.sp,
            maxLines = 1,
        )
        Spacer(Modifier.width(4.dp))
        Text("▾", color = accent ?: Vs.Faint, fontSize = 9.sp)
    }
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

@Composable
private fun PanelHeader(
    title: String,
    subtitle: String,
    statusColor: Color,
    action: Pair<String, () -> Unit>,
) {
    Column {
        Row(
            modifier = Modifier.fillMaxWidth().background(Vs.Panel).padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusDot(statusColor, 8.dp)
            Spacer(Modifier.width(9.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = Vs.Foreground, maxLines = 1)
                Text(subtitle, color = Vs.Faint, fontSize = 11.sp, maxLines = 1)
            }
            Text(
                action.first,
                color = Vs.Claude,
                fontSize = 13.sp,
                modifier = Modifier
                    .clickable(onClick = action.second)
                    .padding(horizontal = 6.dp, vertical = 6.dp),
            )
        }
        HorizontalDivider(color = Vs.Border, thickness = 1.dp)
    }
}

@Composable
private fun StatusDot(color: Color, size: androidx.compose.ui.unit.Dp) {
    Box(Modifier.size(size).background(color, CircleShape))
}

@Composable
private fun vsFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Vs.Claude,
    unfocusedBorderColor = Vs.Border,
    disabledBorderColor = Vs.Surface,
    focusedContainerColor = Vs.Surface,
    unfocusedContainerColor = Vs.Surface,
    disabledContainerColor = Vs.Panel,
    cursorColor = Vs.Claude,
    focusedTextColor = Vs.Foreground,
    unfocusedTextColor = Vs.Foreground,
)

@Composable
private fun ErrorText(message: String, modifier: Modifier = Modifier) {
    Text(message, modifier = modifier.padding(top = 12.dp), color = Vs.Err, fontSize = 12.sp)
}

private fun providerColor(provider: String): Color = when (provider) {
    "claude" -> Vs.Claude
    "codex" -> Vs.Codex
    else -> Vs.Dim
}

private fun providerLabel(provider: String): String = when (provider) {
    "claude" -> "Claude Code"
    "codex" -> "Codex"
    else -> provider
}

private fun connectionColor(state: ConnectionState): Color = when (state) {
    ConnectionState.CONNECTED -> Vs.Ok
    ConnectionState.CONNECTING, ConnectionState.AUTHENTICATING -> Vs.Warn
    ConnectionState.DISCONNECTED -> Vs.Err
}

private fun toolStatusColor(status: String?): Color = when (status) {
    "running", "pending" -> Vs.Warn
    "failed" -> Vs.Err
    else -> Vs.Ok
}

private fun formatClock(timestamp: Long): String {
    val cal = java.util.Calendar.getInstance()
    val now = java.util.Calendar.getInstance()
    cal.timeInMillis = timestamp
    val sameDay = cal.get(java.util.Calendar.YEAR) == now.get(java.util.Calendar.YEAR) &&
        cal.get(java.util.Calendar.DAY_OF_YEAR) == now.get(java.util.Calendar.DAY_OF_YEAR)
    val pattern = if (sameDay) "HH:mm" else "dd.MM HH:mm"
    return java.text.SimpleDateFormat(pattern, java.util.Locale.getDefault()).format(java.util.Date(timestamp))
}

private fun formatWhen(timestamp: Long?): String? {
    if (timestamp == null || timestamp <= 0L) return null
    val elapsed = System.currentTimeMillis() - timestamp
    val minutes = elapsed / 60_000
    return when {
        minutes < 1 -> "только что"
        minutes < 60 -> "$minutes мин назад"
        minutes < 60 * 24 -> "${minutes / 60} ч назад"
        else -> "${minutes / (60 * 24)} дн назад"
    }
}

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.DISCONNECTED -> "Не подключено"
    ConnectionState.CONNECTING -> "Соединение…"
    ConnectionState.AUTHENTICATING -> "Аутентификация…"
    ConnectionState.CONNECTED -> "Подключено"
}
