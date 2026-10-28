package org.xintent.flammenwerfer

import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.net.XIntentTransport

@Composable
fun RoutingModeSelector(
    title: String,
    currentMode: String,
    localOption: String,
    normalOption: String,
    remoteOption: String,
    onModeSelected: (String) -> Unit,
) {
    val isLocal = currentMode.contains("Local", ignoreCase = true)
    val isRemote = currentMode.contains("Remote", ignoreCase = true)
    val isNormal = !isLocal && !isRemote

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.primary,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            RoutingOptionButton("Local", isLocal, Modifier.weight(1f)) { onModeSelected(localOption) }
            RoutingOptionButton("Normal", isNormal, Modifier.weight(1f)) { onModeSelected(normalOption) }
            RoutingOptionButton("Remote", isRemote, Modifier.weight(1f)) { onModeSelected(remoteOption) }
        }
    }
}

@Composable
private fun RoutingOptionButton(
    label: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val container = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant
    val content = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
    Button(
        onClick = onClick,
        colors = ButtonDefaults.buttonColors(containerColor = container, contentColor = content),
        modifier = modifier,
    ) {
        Text(label, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun TransportStatusSection(
    context: Context,
    webSocketState: XIntentTransport.WebSocketState,
    udpState: XIntentTransport.UdpState,
) {
    val hostPort = XIntentPreferences.getServerUrl(context).removePrefix("http://").removePrefix("https://")
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("⚡ Remote Intents WebSocket Connection", style = MaterialTheme.typography.titleSmall)
            val (statusText, btnText) = when (webSocketState) {
                XIntentTransport.WebSocketState.CONNECTED ->
                    "🟢 Connected to Remote Intents (ws://$hostPort/ws)" to "Disconnect WebSocket"
                XIntentTransport.WebSocketState.CONNECTING ->
                    "🟡 Connecting to ws://$hostPort/ws..." to "Connecting..."
                XIntentTransport.WebSocketState.ERROR ->
                    "🔴 Connection Error / Re-trying..." to "Retry WebSocket Connect"
                XIntentTransport.WebSocketState.DISCONNECTED ->
                    "⚪ Disconnected from Remote Intents (Zero Active WebSockets)" to "Connect Remote Intents (WebSocket)"
            }
            val btnColor = when (webSocketState) {
                XIntentTransport.WebSocketState.CONNECTED -> MaterialTheme.colorScheme.error
                XIntentTransport.WebSocketState.CONNECTING -> MaterialTheme.colorScheme.secondary
                else -> MaterialTheme.colorScheme.primary
            }
            Text(statusText, style = MaterialTheme.typography.bodySmall)
            Button(
                onClick = { toggleWebSocketConnection(context, webSocketState) },
                colors = ButtonDefaults.buttonColors(containerColor = btnColor),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(btnText)
            }
        }
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("📻 UDP On-Demand Wake-Up Listener", style = MaterialTheme.typography.titleSmall)
            val currentPort = XIntentPreferences.getUdpPort(context)
            val udpStatusText = when (udpState) {
                XIntentTransport.UdpState.LISTENING ->
                    "🟢 Listening for UDP wake-up pings on port $currentPort (Zero active WebSockets when idle)"
                XIntentTransport.UdpState.ERROR -> "🔴 UDP Listener Error on port $currentPort"
                XIntentTransport.UdpState.DISCONNECTED -> "⚪ UDP Wake Listener Disconnected"
            }
            Text(udpStatusText, style = MaterialTheme.typography.bodySmall)
            val isListening = udpState == XIntentTransport.UdpState.LISTENING
            Button(
                onClick = {
                    if (isListening) XIntentTransport.stopUdpWakeListener() else XIntentClient.startUdpWakeListener(context)
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (isListening) "Stop UDP Wake Listener" else "Start UDP Wake Listener")
            }
        }
    }
}

private fun toggleWebSocketConnection(context: Context, state: XIntentTransport.WebSocketState) {
    if (state == XIntentTransport.WebSocketState.CONNECTED || state == XIntentTransport.WebSocketState.CONNECTING) {
        XIntentTransport.disconnectWebSocket(context)
    } else {
        XIntentClient.connectWebSocket(context)
    }
}

@Composable
fun WebCardsSection(
    discoveredAppCards: List<XIntentClient.AppCardModel>,
    cardAppInput: String,
    onCardAppChange: (String) -> Unit,
    cardNameInput: String,
    onCardNameChange: (String) -> Unit,
    onLaunchCard: (String, String) -> Unit,
) {
    Text("Desktop Web Cards", style = MaterialTheme.typography.titleMedium)
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Discovered Web Cards (/api/tags)", style = MaterialTheme.typography.titleSmall)
            if (discoveredAppCards.isNotEmpty()) {
                discoveredAppCards.forEach { appCard ->
                    DiscoveredAppCardItem(appCard, onLaunchCard)
                }
            } else {
                Text(
                    "No cards discovered yet. Tap 'Fetch /api/tags' to populate available desktop cards.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
            Text("Manual Card Launcher", style = MaterialTheme.typography.labelLarge)
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = cardAppInput,
                    onValueChange = onCardAppChange,
                    label = { Text("App Name") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = cardNameInput,
                    onValueChange = onCardNameChange,
                    label = { Text("Card") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                )
            }
            val resolvedApp = cardAppInput.ifBlank { "intent-test-card" }
            val resolvedCard = cardNameInput.ifBlank { "index" }
            Button(
                onClick = { onLaunchCard(resolvedApp, resolvedCard) },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Render Web Card ($resolvedApp)")
            }
        }
    }
}

@Composable
private fun DiscoveredAppCardItem(
    appCard: XIntentClient.AppCardModel,
    onLaunchCard: (String, String) -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(modifier = Modifier.padding(10.dp)) {
            Text(appCard.appName, style = MaterialTheme.typography.titleSmall)
            if (appCard.description.isNotBlank()) {
                Text(appCard.description, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(modifier = Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                appCard.cards.forEach { cardName ->
                    Button(onClick = { onLaunchCard(appCard.appId, cardName) }) {
                        Text("Launch '$cardName'")
                    }
                }
            }
        }
    }
}

@Composable
fun TestIntentForwardingSection(
    context: Context,
    coroutineScope: CoroutineScope,
    testText: String,
    onTestTextChange: (String) -> Unit,
    canReplace: Boolean,
    onCanReplaceChange: (Boolean) -> Unit,
    action1App: String,
    action2App: String,
    action3App: String,
    ttsTargetApp: String,
    peerHost: String,
    onPeerHostChange: (String) -> Unit,
    isSending: Boolean,
    onSendingChange: (Boolean) -> Unit,
) {
    fun runAsyncIntent(block: suspend () -> Unit) {
        onSendingChange(true)
        coroutineScope.launch {
            block()
            onSendingChange(false)
        }
    }

    fun sendTextIntent(targetApp: String) {
        if (testText.isBlank()) return
        runAsyncIntent {
            XIntentDispatcher.sendTextProcessIntent(
                context = context,
                text = testText,
                targetApp = targetApp,
                canReplace = canReplace,
            )
        }
    }

    Text("Test Intent Forwarding", style = MaterialTheme.typography.titleMedium)
    OutlinedTextField(
        value = testText,
        onValueChange = onTestTextChange,
        label = { Text("Test Text") },
        modifier = Modifier.fillMaxWidth(),
        minLines = 2,
    )
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Checkbox(checked = canReplace, onCheckedChange = onCanReplaceChange)
        Text("Request Text Replacement (replace: true, Accept: *)", style = MaterialTheme.typography.bodyMedium)
    }

    val app1 = action1App.ifBlank { "cool-clips" }
    val app2 = action2App.ifBlank { "cool-bible" }
    val app3 = action3App.ifBlank { "cool-clips" }
    val ttsApp = ttsTargetApp.ifBlank { "cool-tts" }

    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { sendTextIntent(action1App) }, enabled = !isSending && action1App.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
            Text("XIntent Action 1 (--app $app1)")
        }
        Button(onClick = { sendTextIntent(action2App) }, enabled = !isSending && action2App.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
            Text("XIntent Action 2 (--app $app2)")
        }
        Button(onClick = { sendTextIntent(action3App) }, enabled = !isSending && action3App.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
            Text("XIntent Action 3 (--app $app3)")
        }
        Button(
            onClick = {
                runAsyncIntent { XIntentDispatcher.sendTextToSpeechIntent(context = context, text = testText, targetApp = ttsApp) }
            },
            enabled = !isSending && testText.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Test ui.TextToSpeech Intent (--app $ttsApp)")
        }
        Button(
            onClick = {
                runAsyncIntent {
                    val bytes = testText.toByteArray(Charsets.UTF_8)
                    XIntentDispatcher.sendSendToIntent(context, "test_note.txt", "text/plain", bytes.size.toLong(), "text", testText, app1)
                }
            },
            enabled = !isSending && testText.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Test fs.SendTo Blob Intent (--app $app1)")
        }
    }

    Text("Bridge Peering (bridge.Peer / bridge.Unpeer)", style = MaterialTheme.typography.titleMedium)
    OutlinedTextField(
        value = peerHost,
        onValueChange = onPeerHostChange,
        label = { Text("Peer Host (e.g. user-laptop:12346)") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
            onClick = { runAsyncIntent { XIntentDispatcher.sendBridgePeerIntent(context, peerHost) } },
            enabled = !isSending && peerHost.isNotBlank(),
            modifier = Modifier.weight(1f),
        ) {
            Text("Send bridge.Peer")
        }
        Button(
            onClick = { runAsyncIntent { XIntentDispatcher.sendBridgeUnpeerIntent(context, peerHost) } },
            enabled = !isSending && peerHost.isNotBlank(),
            modifier = Modifier.weight(1f),
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
        ) {
            Text("Send bridge.Unpeer")
        }
    }
}
