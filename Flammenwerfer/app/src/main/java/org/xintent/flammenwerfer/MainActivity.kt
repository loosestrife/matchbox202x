package org.xintent.flammenwerfer

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.*
import androidx.activity.compose.setContent
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.core.XIntentLogManager
import org.xintent.flammenwerfer.net.XIntentTransport
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

    var serverUrl by remember { mutableStateOf(XIntentPreferences.getServerUrl(context)) }
    var hostname by remember { mutableStateOf(XIntentPreferences.getHostname(context)) }
    var udpPort by remember { mutableIntStateOf(XIntentPreferences.getUdpPort(context)) }
    var action1App by remember { mutableStateOf(XIntentPreferences.getTargetApp(context, 1)) }
    var action2App by remember { mutableStateOf(XIntentPreferences.getTargetApp(context, 2)) }
    var action3App by remember { mutableStateOf(XIntentPreferences.getTargetApp(context, 3)) }
    var ttsTargetApp by remember { mutableStateOf(XIntentPreferences.getTtsTargetApp(context)) }
    var defaultRemoteDevice by remember { mutableStateOf(XIntentPreferences.getDefaultRemoteDevice(context)) }
    var audioRoutingMode by remember { mutableStateOf(XIntentPreferences.getAudioRoutingMode(context)) }
    var ttsRoutingMode by remember { mutableStateOf(XIntentPreferences.getTtsRoutingMode(context)) }
    var clipboardRoutingMode by remember { mutableStateOf(XIntentPreferences.getClipboardRoutingMode(context)) }
    var fsRoutingMode by remember { mutableStateOf(XIntentPreferences.getFsRoutingMode(context)) }

    var cardAppInput by remember { mutableStateOf("intent-test-card") }
    var cardNameInput by remember { mutableStateOf("index") }
    var testText by remember { mutableStateOf("In the beginning God created the heavens and the earth.") }
    var peerHost by remember { mutableStateOf("user-laptop:12346") }
    var canReplace by remember { mutableStateOf(true) }
    var tagsDisplay by remember { mutableStateOf("Tap 'Fetch /api/tags' to query active desktop intents & apps.") }
    var discoveredAppCards by remember { mutableStateOf<List<XIntentClient.AppCardModel>>(emptyList()) }
    var isFetchingTags by remember { mutableStateOf(false) }
    var logText by remember { mutableStateOf(XIntentLogManager.getLogHistory()) }
    var isSending by remember { mutableStateOf(false) }
    var webSocketState by remember { mutableStateOf(XIntentTransport.webSocketState) }
    var udpState by remember { mutableStateOf(XIntentTransport.udpState) }

    DisposableEffect(Unit) {
        val logListener = { logText = XIntentLogManager.getLogHistory() }
        val wsListener = { state: XIntentTransport.WebSocketState -> webSocketState = state }
        val udpListener = { state: XIntentTransport.UdpState -> udpState = state }
        XIntentLogManager.addLogListener(logListener)
        XIntentTransport.addWebSocketStateListener(wsListener)
        XIntentTransport.addUdpStateListener(udpListener)
        if (XIntentTransport.udpState == XIntentTransport.UdpState.DISCONNECTED) {
            XIntentClient.startUdpWakeListener(context)
        }
        onDispose {
            XIntentLogManager.removeLogListener(logListener)
            XIntentTransport.removeWebSocketStateListener(wsListener)
            XIntentTransport.removeUdpStateListener(udpListener)
        }
    }

    fun refreshApiTags() {
        isFetchingTags = true
        coroutineScope.launch {
            val result = XIntentCatalogParser.fetchApiTags(context)
            isFetchingTags = false
            if (result.success) {
                discoveredAppCards = XIntentCatalogParser.parseAppCards(result.responseBody)
                tagsDisplay = result.responseBody
            } else {
                tagsDisplay = "Failed to fetch /api/tags: ${result.errorMessage}"
            }
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Flammenwerfer Matchbox Android Enclave", style = MaterialTheme.typography.headlineMedium)

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Text("💡 Directives, Shares, TTS & Cards", style = MaterialTheme.typography.titleSmall)
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "1. Long-tap text in any app to use 'XIntent Action 1', 'XIntent Action 2', or 'XIntent Action 3'.\n2. Share files, images, or text using 'Save to Desktop (XIntent)'.\n3. Select 'XIntent Desktop TTS' in Android Text-to-speech settings.\n4. Render web cards directly from desktop apps (/apps/:app/:card)!",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        Text("Configuration & App Targets", style = MaterialTheme.typography.titleMedium)

        OutlinedTextField(value = serverUrl, onValueChange = { serverUrl = it }, label = { Text("Matchbox HTTP Bridge URL") }, placeholder = { Text(XIntentPreferences.DEFAULT_SERVER_URL) }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = hostname, onValueChange = { hostname = it }, label = { Text("Host Name") }, placeholder = { Text(XIntentPreferences.DEFAULT_HOSTNAME) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(
            value = udpPort.takeIf { it > 0 }?.toString().orEmpty(),
            onValueChange = { input -> udpPort = input.filter { it.isDigit() }.toIntOrNull() ?: 0 },
            label = { Text("UDP Wake-Up Port") },
            placeholder = { Text(XIntentPreferences.DEFAULT_UDP_PORT.toString()) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(value = action1App, onValueChange = { action1App = it }, label = { Text("XIntent Action 1 Target App") }, placeholder = { Text("cool-clips") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(value = action2App, onValueChange = { action2App = it }, label = { Text("XIntent Action 2 Target App") }, placeholder = { Text("cool-bible") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(value = action3App, onValueChange = { action3App = it }, label = { Text("XIntent Action 3 Target App") }, placeholder = { Text("cool-clips") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(value = ttsTargetApp, onValueChange = { ttsTargetApp = it }, label = { Text("TTS Target App (ui.TextToSpeech)") }, placeholder = { Text("cool-tts") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(value = defaultRemoteDevice, onValueChange = { defaultRemoteDevice = it }, label = { Text("Default Remote Device Target") }, placeholder = { Text("user-desktop") }, modifier = Modifier.fillMaxWidth(), singleLine = true)

        RoutingModeSelector("🎵 Audio Output Routing Policy (xaudio)", audioRoutingMode, "doLocalAudioCapture", "normal", "doRemoteAudioCapture") {
            audioRoutingMode = it
            XIntentPreferences.setAudioRoutingMode(context, it)
        }
        RoutingModeSelector("🗣️ Text to Speech Routing Policy (ui.TextToSpeech)", ttsRoutingMode, "doLocalTtsCapture", "normal", "doRemoteTtsCapture") {
            ttsRoutingMode = it
            XIntentPreferences.setTtsRoutingMode(context, it)
        }
        RoutingModeSelector("📋 Clipboard Routing Policy (ui.Copy / ui.Paste)", clipboardRoutingMode, "doLocalClipboardCapture", "normal", "doRemoteClipboardCapture") {
            clipboardRoutingMode = it
            XIntentPreferences.setClipboardRoutingMode(context, it)
        }
        RoutingModeSelector("📁 File System Routing Policy (fs.PickFile / fs.SendTo)", fsRoutingMode, "doLocalFsCapture", "normal", "doRemoteFsCapture") {
            fsRoutingMode = it
            XIntentPreferences.setFsRoutingMode(context, it)
        }

        Button(
            onClick = {
                XIntentPreferences.setServerUrl(context, serverUrl)
                XIntentPreferences.setHostname(context, hostname)
                XIntentClient.setUdpPort(context, udpPort.takeIf { it > 0 } ?: XIntentPreferences.DEFAULT_UDP_PORT)
                XIntentPreferences.setTargetApp(context, 1, action1App)
                XIntentPreferences.setTargetApp(context, 2, action2App)
                XIntentPreferences.setTargetApp(context, 3, action3App)
                XIntentPreferences.setTtsTargetApp(context, ttsTargetApp)
                XIntentPreferences.setDefaultRemoteDevice(context, defaultRemoteDevice)
                XIntentPreferences.setAudioRoutingMode(context, audioRoutingMode)
                XIntentPreferences.setTtsRoutingMode(context, ttsRoutingMode)
                XIntentPreferences.setClipboardRoutingMode(context, clipboardRoutingMode)
                XIntentPreferences.setFsRoutingMode(context, fsRoutingMode)
                Toast.makeText(context, "Saved Routing Policies & Settings!", Toast.LENGTH_SHORT).show()
                refreshApiTags()
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Save Configuration & Refresh Tags")
        }

        TransportStatusSection(context, webSocketState, udpState)

        WebCardsSection(
            discoveredAppCards = discoveredAppCards,
            cardAppInput = cardAppInput,
            onCardAppChange = { cardAppInput = it },
            cardNameInput = cardNameInput,
            onCardNameChange = { cardNameInput = it },
            onLaunchCard = { app, card ->
                val intent = Intent(context, CardsActivity::class.java).apply {
                    putExtra(CardsActivity.EXTRA_APP_NAME, app)
                    putExtra(CardsActivity.EXTRA_CARD_NAME, card)
                }
                context.startActivity(intent)
            },
        )

        ApiTagsDisplayCard(tagsDisplay = tagsDisplay, isFetchingTags = isFetchingTags, onRefresh = ::refreshApiTags)

        TestIntentForwardingSection(
            context = context,
            coroutineScope = coroutineScope,
            testText = testText,
            onTestTextChange = { testText = it },
            canReplace = canReplace,
            onCanReplaceChange = { canReplace = it },
            action1App = action1App,
            action2App = action2App,
            action3App = action3App,
            ttsTargetApp = ttsTargetApp,
            peerHost = peerHost,
            onPeerHostChange = { peerHost = it },
            isSending = isSending,
            onSendingChange = { isSending = it },
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Dispatch Status & Log", style = MaterialTheme.typography.titleSmall)
            Button(onClick = { XIntentLogManager.addLog("Cleared log history.") }) {
                Text("Clear Log")
            }
        }

        Card(
            modifier = Modifier.fillMaxWidth().height(240.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            SelectionContainer {
                Text(
                    text = logText,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(12.dp).verticalScroll(rememberScrollState()),
                )
            }
        }
    }
}

@Composable
private fun ApiTagsDisplayCard(
    tagsDisplay: String,
    isFetchingTags: Boolean,
    onRefresh: () -> Unit,
) {
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
                Text("🌐 Desktop Active Tags (/api/tags)", style = MaterialTheme.typography.titleSmall)
                Button(onClick = onRefresh, enabled = !isFetchingTags) {
                    Text(if (isFetchingTags) "Loading..." else "Fetch /api/tags")
                }
            }
            Spacer(modifier = Modifier.height(8.dp))
            Card(
                modifier = Modifier.fillMaxWidth().height(180.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                SelectionContainer {
                    Text(
                        text = tagsDisplay,
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.padding(12.dp).verticalScroll(rememberScrollState()),
                    )
                }
            }
        }
    }
}
