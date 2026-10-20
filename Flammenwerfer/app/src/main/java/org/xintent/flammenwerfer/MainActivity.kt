package org.xintent.flammenwerfer

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.xintent.flammenwerfer.ui.theme.FlammenwerferTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            FlammenwerferTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    MainScreen(modifier = Modifier.padding(innerPadding))
                }
            }
        }
    }
}

@Composable
fun MainScreen(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()

    var serverUrl by remember { mutableStateOf(XIntentClient.getServerUrl(context)) }
    var hostname by remember { mutableStateOf(XIntentClient.getHostname(context)) }
    var udpPort by remember { mutableIntStateOf(XIntentClient.getUdpPort(context)) }
    var action1App by remember { mutableStateOf(XIntentClient.getTargetApp(context, 1)) }
    var action2App by remember { mutableStateOf(XIntentClient.getTargetApp(context, 2)) }
    var action3App by remember { mutableStateOf(XIntentClient.getTargetApp(context, 3)) }
    var ttsTargetApp by remember { mutableStateOf(XIntentClient.getTtsTargetApp(context)) }
    var defaultRemoteDevice by remember { mutableStateOf(XIntentClient.getDefaultRemoteDevice(context)) }
    var audioRoutingMode by remember { mutableStateOf(XIntentClient.getAudioRoutingMode(context)) }
    var ttsRoutingMode by remember { mutableStateOf(XIntentClient.getTtsRoutingMode(context)) }
    var clipboardRoutingMode by remember { mutableStateOf(XIntentClient.getClipboardRoutingMode(context)) }
    var fsRoutingMode by remember { mutableStateOf(XIntentClient.getFsRoutingMode(context)) }

    var cardAppInput by remember { mutableStateOf("intent-test-card") }
    var cardNameInput by remember { mutableStateOf("index") }

    var testText by remember { mutableStateOf("In the beginning God created the heavens and the earth.") }
    var peerHost by remember { mutableStateOf("user-laptop:12346") }
    var canReplace by remember { mutableStateOf(true) }
    var tagsDisplay by remember { mutableStateOf("Tap 'Fetch /api/tags' to query active desktop intents & apps.") }
    var discoveredAppCards by remember { mutableStateOf<List<XIntentClient.AppCardModel>>(emptyList()) }
    var isFetchingTags by remember { mutableStateOf(false) }
    var logText by remember { mutableStateOf(XIntentClient.getLogHistory()) }
    var isSending by remember { mutableStateOf(false) }
    var webSocketState by remember { mutableStateOf(XIntentClient.webSocketState) }
    var udpState by remember { mutableStateOf(XIntentClient.udpState) }

    DisposableEffect(Unit) {
        val listener = {
            logText = XIntentClient.getLogHistory()
        }
        val wsListener = { state: XIntentClient.WebSocketState ->
            webSocketState = state
        }
        val udpListener = { state: XIntentClient.UdpState ->
            udpState = state
        }
        XIntentClient.addLogListener(listener)
        XIntentClient.addWebSocketStateListener(wsListener)
        XIntentClient.addUdpStateListener(udpListener)
        if (XIntentClient.udpState == XIntentClient.UdpState.DISCONNECTED) {
            XIntentClient.startUdpWakeListener(context)
        }
        onDispose {
            XIntentClient.removeLogListener(listener)
            XIntentClient.removeWebSocketStateListener(wsListener)
            XIntentClient.removeUdpStateListener(udpListener)
        }
    }

    fun launchWebCard(app: String, card: String) {
        val intent = Intent(context, CardsActivity::class.java).apply {
            putExtra(CardsActivity.EXTRA_APP_NAME, app)
            putExtra(CardsActivity.EXTRA_CARD_NAME, card)
        }
        context.startActivity(intent)
    }

    fun refreshApiTags() {
        isFetchingTags = true
        coroutineScope.launch {
            val result = XIntentClient.fetchApiTags(context)
            isFetchingTags = false
            tagsDisplay = if (result.success) {
                discoveredAppCards = XIntentClient.parseAppCards(result.responseBody)
                result.responseBody
            } else {
                "Failed to fetch /api/tags: ${result.errorMessage}"
            }
        }
    }

    fun sendIntent(targetApp: String) {
        if (testText.isBlank()) return
        isSending = true

        coroutineScope.launch {
            XIntentClient.sendTextProcessIntent(
                context = context,
                text = testText,
                targetApp = targetApp,
                canReplace = canReplace,
            )
            isSending = false
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = "Flammenwerfer Matchbox Android Enclave",
            style = MaterialTheme.typography.headlineMedium,
        )

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Text(
                    text = "💡 Directives, Shares, TTS & Cards",
                    style = MaterialTheme.typography.titleSmall,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "1. Long-tap text in any app to use 'XIntent Action 1', 'XIntent Action 2', or 'XIntent Action 3'.\n2. Share files, images, or text using 'Save to Desktop (XIntent)'.\n3. Select 'XIntent Desktop TTS' in Android Text-to-speech settings.\n4. Render web cards directly from desktop apps (/apps/:app/:card)!",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        // Bridge Server & App Targets Settings
        Text(
            text = "Configuration & App Targets",
            style = MaterialTheme.typography.titleMedium,
        )

        OutlinedTextField(
            value = serverUrl,
            onValueChange = { serverUrl = it },
            label = { Text("Matchbox HTTP Bridge URL") },
            placeholder = { Text(XIntentClient.DEFAULT_SERVER_URL) },
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = hostname,
            onValueChange = { hostname = it },
            label = { Text("Host Name") },
            placeholder = { Text(XIntentClient.DEFAULT_HOSTNAME) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        OutlinedTextField(
            value = if (udpPort == 0) "" else udpPort.toString(),
            onValueChange = { input ->
                udpPort = input.filter { it.isDigit() }.toIntOrNull() ?: 0
            },
            label = { Text("UDP Wake-Up Port") },
            placeholder = { Text(XIntentClient.DEFAULT_UDP_PORT.toString()) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        OutlinedTextField(
            value = action1App,
            onValueChange = { action1App = it },
            label = { Text("XIntent Action 1 Target App") },
            placeholder = { Text("cool-clips") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        OutlinedTextField(
            value = action2App,
            onValueChange = { action2App = it },
            label = { Text("XIntent Action 2 Target App") },
            placeholder = { Text("cool-bible") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        OutlinedTextField(
            value = action3App,
            onValueChange = { action3App = it },
            label = { Text("XIntent Action 3 Target App") },
            placeholder = { Text("cool-clips") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        OutlinedTextField(
            value = ttsTargetApp,
            onValueChange = { ttsTargetApp = it },
            label = { Text("TTS Target App (ui.TextToSpeech)") },
            placeholder = { Text("cool-tts") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        OutlinedTextField(
            value = defaultRemoteDevice,
            onValueChange = { defaultRemoteDevice = it },
            label = { Text("Default Remote Device Target") },
            placeholder = { Text("user-desktop") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        RoutingModeSelector(
            title = "🎵 Audio Output Routing Policy (xaudio)",
            currentMode = audioRoutingMode,
            localOption = "doLocalAudioCapture",
            normalOption = "normal",
            remoteOption = "doRemoteAudioCapture",
            onModeSelected = {
                audioRoutingMode = it
                XIntentClient.setAudioRoutingMode(context, it)
            }
        )

        RoutingModeSelector(
            title = "🗣️ Text to Speech Routing Policy (ui.TextToSpeech)",
            currentMode = ttsRoutingMode,
            localOption = "doLocalTtsCapture",
            normalOption = "normal",
            remoteOption = "doRemoteTtsCapture",
            onModeSelected = {
                ttsRoutingMode = it
                XIntentClient.setTtsRoutingMode(context, it)
            }
        )

        RoutingModeSelector(
            title = "📋 Clipboard Routing Policy (ui.Copy / ui.Paste)",
            currentMode = clipboardRoutingMode,
            localOption = "doLocalClipboardCapture",
            normalOption = "normal",
            remoteOption = "doRemoteClipboardCapture",
            onModeSelected = {
                clipboardRoutingMode = it
                XIntentClient.setClipboardRoutingMode(context, it)
            }
        )

        RoutingModeSelector(
            title = "📁 File System Routing Policy (fs.PickFile / fs.SendTo)",
            currentMode = fsRoutingMode,
            localOption = "doLocalFsCapture",
            normalOption = "normal",
            remoteOption = "doRemoteFsCapture",
            onModeSelected = {
                fsRoutingMode = it
                XIntentClient.setFsRoutingMode(context, it)
            }
        )

        Button(
            onClick = {
                XIntentClient.setServerUrl(context, serverUrl)
                XIntentClient.setHostname(context, hostname)
                XIntentClient.setUdpPort(context, if (udpPort == 0) XIntentClient.DEFAULT_UDP_PORT else udpPort)
                XIntentClient.setTargetApp(context, 1, action1App)
                XIntentClient.setTargetApp(context, 2, action2App)
                XIntentClient.setTargetApp(context, 3, action3App)
                XIntentClient.setTtsTargetApp(context, ttsTargetApp)
                XIntentClient.setDefaultRemoteDevice(context, defaultRemoteDevice)
                XIntentClient.setAudioRoutingMode(context, audioRoutingMode)
                XIntentClient.setTtsRoutingMode(context, ttsRoutingMode)
                XIntentClient.setClipboardRoutingMode(context, clipboardRoutingMode)
                XIntentClient.setFsRoutingMode(context, fsRoutingMode)
                Toast.makeText(context, "Saved Routing Policies & Settings!", Toast.LENGTH_SHORT).show()
                refreshApiTags()
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Save Configuration & Refresh Tags")
        }

        // Remote Intents WebSocket Connection Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "⚡ Remote Intents WebSocket Connection",
                    style = MaterialTheme.typography.titleSmall,
                )
                val statusText = when (webSocketState) {
                    XIntentClient.WebSocketState.CONNECTED -> "🟢 Connected to Remote Intents (ws://${XIntentClient.getServerUrl(context).removePrefix("http://").removePrefix("https://")}/ws)"
                    XIntentClient.WebSocketState.CONNECTING -> "🟡 Connecting to ws://${XIntentClient.getServerUrl(context).removePrefix("http://").removePrefix("https://")}/ws..."
                    XIntentClient.WebSocketState.ERROR -> "🔴 Connection Error / Re-trying..."
                    XIntentClient.WebSocketState.DISCONNECTED -> "⚪ Disconnected from Remote Intents (Zero Active WebSockets)"
                }
                val btnText = when (webSocketState) {
                    XIntentClient.WebSocketState.CONNECTED -> "Disconnect WebSocket"
                    XIntentClient.WebSocketState.CONNECTING -> "Connecting..."
                    XIntentClient.WebSocketState.ERROR -> "Retry WebSocket Connect"
                    XIntentClient.WebSocketState.DISCONNECTED -> "Connect Remote Intents (WebSocket)"
                }
                val btnColor = when (webSocketState) {
                    XIntentClient.WebSocketState.CONNECTED -> MaterialTheme.colorScheme.error
                    XIntentClient.WebSocketState.CONNECTING -> MaterialTheme.colorScheme.secondary
                    else -> MaterialTheme.colorScheme.primary
                }

                Text(
                    text = statusText,
                    style = MaterialTheme.typography.bodySmall,
                )
                Button(
                    onClick = {
                        if (webSocketState == XIntentClient.WebSocketState.CONNECTED || webSocketState == XIntentClient.WebSocketState.CONNECTING) {
                            XIntentClient.disconnectWebSocket(context)
                        } else {
                            XIntentClient.connectWebSocket(context)
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = btnColor),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(btnText)
                }
            }
        }

        // UDP On-Demand Wake-Up Listener Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "📻 UDP On-Demand Wake-Up Listener",
                    style = MaterialTheme.typography.titleSmall,
                )
                val currentPort = XIntentClient.getUdpPort(context)
                val udpStatusText = when (udpState) {
                    XIntentClient.UdpState.LISTENING -> "🟢 Listening for UDP wake-up pings on port $currentPort (Zero active WebSockets when idle)"
                    XIntentClient.UdpState.ERROR -> "🔴 UDP Listener Error on port $currentPort"
                    XIntentClient.UdpState.DISCONNECTED -> "⚪ UDP Wake Listener Disconnected"
                }

                Text(
                    text = udpStatusText,
                    style = MaterialTheme.typography.bodySmall,
                )
                Button(
                    onClick = {
                        if (udpState == XIntentClient.UdpState.LISTENING) {
                            XIntentClient.stopUdpWakeListener()
                        } else {
                            XIntentClient.startUdpWakeListener(context)
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (udpState == XIntentClient.UdpState.LISTENING) "Stop UDP Wake Listener" else "Start UDP Wake Listener")
                }
            }
        }

        // Web Cards Section
        Text(
            text = "Desktop Web Cards",
            style = MaterialTheme.typography.titleMedium,
        )

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "Discovered Web Cards (/api/tags)",
                    style = MaterialTheme.typography.titleSmall,
                )

                if (discoveredAppCards.isNotEmpty()) {
                    discoveredAppCards.forEach { appCard ->
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                        ) {
                            Column(modifier = Modifier.padding(10.dp)) {
                                Text(
                                    text = appCard.appName,
                                    style = MaterialTheme.typography.titleSmall,
                                )
                                if (appCard.description.isNotBlank()) {
                                    Text(
                                        text = appCard.description,
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                }
                                Spacer(modifier = Modifier.height(6.dp))
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    appCard.cards.forEach { cardName ->
                                        Button(
                                            onClick = { launchWebCard(appCard.appId, cardName) },
                                        ) {
                                            Text("Launch '$cardName'")
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    Text(
                        text = "No cards discovered yet. Tap 'Fetch /api/tags' to populate available desktop cards.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))

                Text(
                    text = "Manual Card Launcher",
                    style = MaterialTheme.typography.labelLarge,
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = cardAppInput,
                        onValueChange = { cardAppInput = it },
                        label = { Text("App Name") },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                    )

                    OutlinedTextField(
                        value = cardNameInput,
                        onValueChange = { cardNameInput = it },
                        label = { Text("Card") },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                    )
                }

                Button(
                    onClick = { launchWebCard(cardAppInput.ifBlank { "intent-test-card" }, cardNameInput.ifBlank { "index" }) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Render Web Card (${cardAppInput.ifBlank { "intent-test-card" }})")
                }
            }
        }

        // API Tags Display Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "🌐 Desktop Active Tags (/api/tags)",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Button(
                        onClick = { refreshApiTags() },
                        enabled = !isFetchingTags,
                    ) {
                        Text(if (isFetchingTags) "Loading..." else "Fetch /api/tags")
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))

                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(180.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                ) {
                    SelectionContainer {
                        Text(
                            text = tagsDisplay,
                            fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier
                                .padding(12.dp)
                                .verticalScroll(rememberScrollState()),
                        )
                    }
                }
            }
        }

        // Test Dispatch Section
        Text(
            text = "Test Intent Forwarding",
            style = MaterialTheme.typography.titleMedium,
        )

        OutlinedTextField(
            value = testText,
            onValueChange = { testText = it },
            label = { Text("Test Text") },
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
        )

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Checkbox(
                checked = canReplace,
                onCheckedChange = { canReplace = it },
            )
            Text(
                text = "Request Text Replacement (replace: true, Accept: *)",
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = { sendIntent(action1App) },
                enabled = !isSending && action1App.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("XIntent Action 1 (--app ${action1App.ifBlank { "cool-clips" }})")
            }

            Button(
                onClick = { sendIntent(action2App) },
                enabled = !isSending && action2App.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("XIntent Action 2 (--app ${action2App.ifBlank { "cool-bible" }})")
            }

            Button(
                onClick = { sendIntent(action3App) },
                enabled = !isSending && action3App.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("XIntent Action 3 (--app ${action3App.ifBlank { "cool-clips" }})")
            }

            Button(
                onClick = {
                    if (testText.isNotBlank()) {
                        isSending = true
                        coroutineScope.launch {
                            XIntentClient.sendTextToSpeechIntent(
                                context = context,
                                text = testText,
                                targetApp = ttsTargetApp.ifBlank { "cool-tts" },
                            )
                            isSending = false
                        }
                    }
                },
                enabled = !isSending && testText.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Test ui.TextToSpeech Intent (--app ${ttsTargetApp.ifBlank { "cool-tts" }})")
            }

            Button(
                onClick = {
                    if (testText.isNotBlank()) {
                        isSending = true
                        coroutineScope.launch {
                            val bytes = testText.toByteArray(Charsets.UTF_8)
                            XIntentClient.sendSendToIntent(
                                context = context,
                                name = "test_note.txt",
                                type = "text/plain",
                                size = bytes.size.toLong(),
                                dataType = "text",
                                data = testText,
                                targetApp = action1App.ifBlank { "cool-clips" },
                            )
                            isSending = false
                        }
                    }
                },
                enabled = !isSending && testText.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Test fs.SendTo Blob Intent (--app ${action1App.ifBlank { "cool-clips" }})")
            }
        }

        // Bridge Peering Section
        Text(
            text = "Bridge Peering (bridge.Peer / bridge.Unpeer)",
            style = MaterialTheme.typography.titleMedium,
        )

        OutlinedTextField(
            value = peerHost,
            onValueChange = { peerHost = it },
            label = { Text("Peer Host (e.g. user-laptop:12346)") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = {
                    if (peerHost.isNotBlank()) {
                        isSending = true
                        coroutineScope.launch {
                            XIntentClient.sendBridgePeerIntent(
                                context = context,
                                peerHost = peerHost,
                            )
                            isSending = false
                        }
                    }
                },
                enabled = !isSending && peerHost.isNotBlank(),
                modifier = Modifier.weight(1f),
            ) {
                Text("Send bridge.Peer")
            }

            Button(
                onClick = {
                    if (peerHost.isNotBlank()) {
                        isSending = true
                        coroutineScope.launch {
                            XIntentClient.sendBridgeUnpeerIntent(
                                context = context,
                                peerHost = peerHost,
                            )
                            isSending = false
                        }
                    }
                },
                enabled = !isSending && peerHost.isNotBlank(),
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
            ) {
                Text("Send bridge.Unpeer")
            }
        }

        // Response Log
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "Dispatch Status & Log",
                style = MaterialTheme.typography.titleSmall,
            )
            Button(
                onClick = {
                    XIntentClient.addLog("Cleared log history.")
                },
            ) {
                Text("Clear Log")
            }
        }

        Card(
            modifier = Modifier
                .fillMaxWidth()
                .height(240.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            SelectionContainer {
                Text(
                    text = logText,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .padding(12.dp)
                        .verticalScroll(rememberScrollState()),
                )
            }
        }
    }
}

@Composable
fun RoutingModeSelector(
    title: String,
    currentMode: String,
    localOption: String,
    normalOption: String,
    remoteOption: String,
    onModeSelected: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.primary,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            val isLocal = currentMode.contains("Local", ignoreCase = true)
            val isRemote = currentMode.contains("Remote", ignoreCase = true)
            val isNormal = !isLocal && !isRemote

            Button(
                onClick = { onModeSelected(localOption) },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isLocal) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = if (isLocal) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
                ),
                modifier = Modifier.weight(1f),
            ) {
                Text("Local", style = MaterialTheme.typography.bodySmall)
            }

            Button(
                onClick = { onModeSelected(normalOption) },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isNormal) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = if (isNormal) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
                ),
                modifier = Modifier.weight(1f),
            ) {
                Text("Normal", style = MaterialTheme.typography.bodySmall)
            }

            Button(
                onClick = { onModeSelected(remoteOption) },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isRemote) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = if (isRemote) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
                ),
                modifier = Modifier.weight(1f),
            ) {
                Text("Remote", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
