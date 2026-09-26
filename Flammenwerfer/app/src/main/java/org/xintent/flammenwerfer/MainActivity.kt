package org.xintent.flammenwerfer

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

    var testText by remember { mutableStateOf("In the beginning God created the heavens and the earth.") }
    var canReplace by remember { mutableStateOf(true) }
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
                    text = "💡 Long-Tap Menu Directives",
                    style = MaterialTheme.typography.titleSmall,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Select text in any app (Chrome, Notes, etc.) and long-tap to find 'XIntent Action 1', 'XIntent Action 2', or 'XIntent Action 3' in the context menu. If the text field is editable, replacement text returned by the HTTP bridge will automatically replace the selected text!",
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

        Button(
            onClick = {
                XIntentClient.setServerUrl(context, serverUrl)
                XIntentClient.setTargetApp(context, 1, action1App)
                XIntentClient.setTargetApp(context, 2, action2App)
                XIntentClient.setTargetApp(context, 3, action3App)
                Toast.makeText(context, "Saved Settings & Target Apps!", Toast.LENGTH_SHORT).show()
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Save Configuration")
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
                text = "Request Text Replacement (replace: true, Accept: text/plain)",
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
