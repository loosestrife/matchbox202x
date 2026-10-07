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
    var action1App by remember { mutableStateOf(XIntentClient.getTargetApp(context, 1)) }
    var action2App by remember { mutableStateOf(XIntentClient.getTargetApp(context, 2)) }
    var action3App by remember { mutableStateOf(XIntentClient.getTargetApp(context, 3)) }
    var localFsEnabled by remember { mutableStateOf(XIntentClient.isLocalFsEnabled(context)) }
    var localClipboardEnabled by remember { mutableStateOf(XIntentClient.isLocalClipboardEnabled(context)) }
    var localTtsEnabled by remember { mutableStateOf(XIntentClient.isLocalTtsEnabled(context)) }

    var cardAppInput by remember { mutableStateOf("intent-test-card") }
    var cardNameInput by remember { mutableStateOf("index") }

    var testText by remember { mutableStateOf("In the beginning God created the heavens and the earth.") }
    var canReplace by remember { mutableStateOf(true) }
    var tagsDisplay by remember { mutableStateOf("Tap 'Fetch /api/tags' to query active desktop intents & apps.") }
    var discoveredAppCards by remember { mutableStateOf<List<XIntentClient.AppCardModel>>(emptyList()) }
    var isFetchingTags by remember { mutableStateOf(false) }
    var logText by remember { mutableStateOf(XIntentClient.getLogHistory()) }
    var isSending by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        val listener = {
            logText = XIntentClient.getLogHistory()
        }
        XIntentClient.addLogListener(listener)
        onDispose {
            XIntentClient.removeLogListener(listener)
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
            text = "Flammenwerfer HTTP Bridge",
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
            label = { Text("HTTP Bridge URL") },
            placeholder = { Text(XIntentClient.DEFAULT_SERVER_URL) },
            modifier = Modifier.fillMaxWidth(),
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

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Checkbox(
                checked = localFsEnabled,
                onCheckedChange = {
                    localFsEnabled = it
                    XIntentClient.setLocalFsEnabled(context, it)
                },
            )
            Text(
                text = "Redirect Web Card fs.PickFile & fs.SaveAs to Local Android Storage (SAF)",
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Checkbox(
                checked = localClipboardEnabled,
                onCheckedChange = {
                    localClipboardEnabled = it
                    XIntentClient.setLocalClipboardEnabled(context, it)
                },
            )
            Text(
                text = "Redirect Web Card ui.Copy & ui.Paste to Local Android Clipboard",
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Checkbox(
                checked = localTtsEnabled,
                onCheckedChange = {
                    localTtsEnabled = it
                    XIntentClient.setLocalTtsEnabled(context, it)
                },
            )
            Text(
                text = "Redirect Web Card ui.TextToSpeech to Local Android Phone Speech Engine (Cave Mode)",
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Button(
            onClick = {
                XIntentClient.setServerUrl(context, serverUrl)
                XIntentClient.setTargetApp(context, 1, action1App)
                XIntentClient.setTargetApp(context, 2, action2App)
                XIntentClient.setTargetApp(context, 3, action3App)
                XIntentClient.setLocalFsEnabled(context, localFsEnabled)
                XIntentClient.setLocalClipboardEnabled(context, localClipboardEnabled)
                XIntentClient.setLocalTtsEnabled(context, localTtsEnabled)
                Toast.makeText(context, "Saved Settings & Target Apps!", Toast.LENGTH_SHORT).show()
                refreshApiTags()
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Save Configuration & Refresh Tags")
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
                                            onClick = { launchWebCard(appCard.appName, cardName) },
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
                                targetApp = action1App.ifBlank { "cool-tts" },
                            )
                            isSending = false
                        }
                    }
                },
                enabled = !isSending && testText.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Test ui.TextToSpeech Intent (--app ${action1App.ifBlank { "cool-tts" }})")
            }

            Button(
                onClick = {
                    if (testText.isNotBlank()) {
                        isSending = true
                        coroutineScope.launch {
                            val bytes = testText.toByteArray(Charsets.UTF_8)
                            XIntentClient.sendSaveAsIntent(
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
                Text("Test fs.SaveAs Blob Intent (--app ${action1App.ifBlank { "cool-clips" }})")
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
