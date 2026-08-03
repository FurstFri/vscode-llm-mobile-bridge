package com.furstfri.llmmobilebridge

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel

private val BridgeColors = darkColorScheme(
    primary = Color(0xFF70B7FF),
    onPrimary = Color(0xFF001D36),
    background = Color(0xFF09111F),
    surface = Color(0xFF111D30),
    surfaceVariant = Color(0xFF192A43),
    onSurface = Color(0xFFEAF2FF),
    onSurfaceVariant = Color(0xFFB8C8E0),
    error = Color(0xFFFFB4AB),
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
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
    Scaffold(containerColor = MaterialTheme.colorScheme.background) { padding ->
        when {
            state.pairing == null -> PairingScreen(state, model, padding)
            state.selectedSession != null -> TimelineScreen(state, model, padding)
            else -> SessionsScreen(state, model, padding)
        }
    }
}

@Composable
private fun PairingScreen(state: BridgeUiState, model: BridgeViewModel, padding: PaddingValues) {
    Column(
        modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("LLM Mobile Bridge", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(
            "В VS Code выполните “Copy Pairing Payload”, затем вставьте значение сюда.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(
            value = state.pairingText,
            onValueChange = model::updatePairingText,
            modifier = Modifier.fillMaxWidth(),
            minLines = 4,
            label = { Text("Pairing JSON") },
        )
        state.error?.let { ErrorText(it) }
        Spacer(Modifier.height(16.dp))
        Button(onClick = model::pair, enabled = state.pairingText.isNotBlank()) {
            Text("Подключить")
        }
    }
}

@Composable
private fun SessionsScreen(state: BridgeUiState, model: BridgeViewModel, padding: PaddingValues) {
    Column(Modifier.fillMaxSize().padding(padding)) {
        Header(
            title = "Сессии",
            subtitle = connectionLabel(state.connection),
            primaryAction = "Обновить" to model::refresh,
        )
        state.error?.let { ErrorText(it, Modifier.padding(horizontal = 16.dp)) }
        if (state.connection == ConnectionState.DISCONNECTED) {
            Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = model::reconnect) { Text("Переподключить") }
                OutlinedButton(onClick = model::unpair) { Text("Забыть связь") }
            }
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(state.sessions, key = BridgeSession::ref) { session ->
                SessionCard(session) { model.select(session) }
            }
            if (state.sessions.isEmpty() && state.connection == ConnectionState.CONNECTED) {
                item { Text("Для текущего workspace сессии не найдены.") }
            }
        }
    }
}

@Composable
private fun TimelineScreen(state: BridgeUiState, model: BridgeViewModel, padding: PaddingValues) {
    val session = state.selectedSession ?: return
    Column(Modifier.fillMaxSize().padding(padding)) {
        Header(
            title = session.title,
            subtitle = "${session.provider} · ${session.state}",
            primaryAction = "Назад" to model::closeTimeline,
        )
        state.error?.let { ErrorText(it, Modifier.padding(horizontal = 16.dp)) }
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(state.timeline, key = TimelineItem::id) { item -> TimelineCard(item) }
        }
        if (!session.capabilities.canStartTurn) {
            Text(
                "Только чтение: resume будет включён после compatibility acceptance check.",
                modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Header(title: String, subtitle: String, primaryAction: Pair<String, () -> Unit>) {
    Row(
        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        OutlinedButton(onClick = primaryAction.second) { Text(primaryAction.first) }
    }
}

@Composable
private fun SessionCard(session: BridgeSession, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(session.title, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(5.dp))
            Text("${session.provider} · ${session.state}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!session.capabilities.canStartTurn) {
                Spacer(Modifier.height(5.dp))
                Text("READ ONLY", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun TimelineCard(item: TimelineItem) {
    val background = when (item.role) {
        "user" -> Color(0xFF173B5C)
        "assistant" -> MaterialTheme.colorScheme.surface
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    Card(
        colors = CardDefaults.cardColors(containerColor = background),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(
                (item.role ?: item.kind).uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(5.dp))
            Text(
                item.text.ifBlank { item.status ?: item.kind },
                fontFamily = if (item.kind == "tool") FontFamily.Monospace else FontFamily.Default,
            )
        }
    }
}

@Composable
private fun ErrorText(message: String, modifier: Modifier = Modifier) {
    Text(message, modifier = modifier.padding(top = 12.dp), color = MaterialTheme.colorScheme.error)
}

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.DISCONNECTED -> "Не подключено"
    ConnectionState.CONNECTING -> "Соединение…"
    ConnectionState.AUTHENTICATING -> "Аутентификация…"
    ConnectionState.CONNECTED -> "Подключено"
}
