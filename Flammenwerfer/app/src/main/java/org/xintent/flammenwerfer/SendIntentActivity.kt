package org.xintent.flammenwerfer

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.xintent.flammenwerfer.ui.theme.FlammenwerferTheme

class SendIntentActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val action = intent?.action
        if (action == Intent.ACTION_GET_CONTENT || action == Intent.ACTION_OPEN_DOCUMENT) {
            lifecycleScope.launch {
                SendIntentController.performGetContent(this@SendIntentActivity)
                finish()
            }
            return
        }

        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) {
            finish()
            return
        }

        val streamUri = SendIntentController.extractStreamUri(intent)
        val textContent = intent.getStringExtra(Intent.EXTRA_TEXT)
        if (streamUri == null && textContent.isNullOrBlank()) {
            Toast.makeText(this, "No content or file attached to share", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        val mimeType = intent?.type ?: "application/octet-stream"
        setContent {
            FlammenwerferTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    SendToTargetPickerScreen(
                        streamUri = streamUri,
                        mimeType = mimeType,
                        onTargetSelected = { selectedTarget ->
                            if (streamUri == null && !textContent.isNullOrBlank()) {
                                lifecycleScope.launch {
                                    SendIntentController.performTextShare(applicationContext, textContent, selectedTarget)
                                    finish()
                                }
                            }
                        },
                        onDismiss = { finish() },
                    )
                }
            }
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun SendToTargetPickerScreen(
        streamUri: Uri?,
        mimeType: String,
        onTargetSelected: (String) -> Unit,
        onDismiss: () -> Unit,
    ) {
        var targets by remember { mutableStateOf<List<XIntentClient.SendToTarget>>(emptyList()) }
        var isLoading by remember { mutableStateOf(true) }
        var statusMessage by remember { mutableStateOf<String?>(null) }
        var fileName by remember { mutableStateOf(streamUri?.lastPathSegment ?: "shared_attachment") }
        var isUploading by remember { mutableStateOf(false) }
        var uploadProgress by remember { mutableStateOf(0f) }
        var uploadStatusText by remember { mutableStateOf("") }

        LaunchedEffect(streamUri) {
            SendIntentController.queryDisplayName(this@SendIntentActivity, streamUri)?.let { fileName = it }
        }

        LaunchedEffect(Unit) {
            isLoading = true
            val (fetchedTargets, err) = SendIntentController.fetchSendToTargets(applicationContext)
            targets = fetchedTargets
            statusMessage = err
            isLoading = false
        }

        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Column {
                            Text("Send to XIntent Desktop", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                            Text(
                                if (streamUri != null) "File: $fileName ($mimeType)" else "Text Attachment",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                )
            }
        ) { paddingValues ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
                    .padding(16.dp),
            ) {
                when {
                    isUploading -> UploadProgressBox(uploadProgress, uploadStatusText)
                    isLoading -> LoadingDestinationsBox()
                    else -> DestinationListContent(
                        statusMessage = statusMessage,
                        targets = targets,
                        onDismiss = onDismiss,
                        onSelectTarget = { appId ->
                            if (streamUri != null) {
                                isUploading = true
                                uploadStatusText = "Preparing upload..."
                                lifecycleScope.launch {
                                    SendIntentController.performUriShare(applicationContext, streamUri, mimeType, appId) { prog, text ->
                                        uploadProgress = prog
                                        uploadStatusText = text
                                    }
                                    finish()
                                }
                            } else {
                                onTargetSelected(appId)
                            }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun UploadProgressBox(uploadProgress: Float, uploadStatusText: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Card(modifier = Modifier.padding(24.dp).fillMaxWidth()) {
            Column(modifier = Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                CircularProgressIndicator(progress = { uploadProgress })
                Spacer(modifier = Modifier.height(16.dp))
                Text(uploadStatusText, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                Spacer(modifier = Modifier.height(8.dp))
                LinearProgressIndicator(progress = { uploadProgress }, modifier = Modifier.fillMaxWidth())
                Spacer(modifier = Modifier.height(8.dp))
                Text("${(uploadProgress * 100).toInt()}%", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun LoadingDestinationsBox() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator()
            Spacer(modifier = Modifier.height(16.dp))
            Text("Discovering active desktop destinations (/api/tags)...")
        }
    }
}

@Composable
private fun ColumnScope.DestinationListContent(
    statusMessage: String?,
    targets: List<XIntentClient.SendToTarget>,
    onDismiss: () -> Unit,
    onSelectTarget: (String) -> Unit,
) {
    statusMessage?.let { msg ->
        Text(
            text = msg,
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(bottom = 12.dp),
        )
    }
    Text(
        text = "Select Destination App:",
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(bottom = 8.dp),
    )
    LazyColumn(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(targets) { target ->
            Card(
                modifier = Modifier.fillMaxWidth().clickable { onSelectTarget(target.appId) },
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(target.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.height(4.dp))
                    Text("Target ID: ${target.appId}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    if (target.description.isNotBlank()) {
                        Spacer(modifier = Modifier.height(2.dp))
                        Text(target.description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
    Spacer(modifier = Modifier.height(16.dp))
    OutlinedButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
        Text("Cancel")
    }
}
