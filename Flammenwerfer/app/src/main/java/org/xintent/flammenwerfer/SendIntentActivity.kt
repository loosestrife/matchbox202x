package org.xintent.flammenwerfer

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
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
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.xintent.flammenwerfer.ui.theme.FlammenwerferTheme
import java.io.File

class SendIntentActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val action = intent?.action
        val type = intent?.type

        if (action == Intent.ACTION_GET_CONTENT || action == Intent.ACTION_OPEN_DOCUMENT) {
            handleGetContent()
        } else if (action == Intent.ACTION_SEND || action == Intent.ACTION_SEND_MULTIPLE) {
            val streamUri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_STREAM)
            }
            val textContent = intent.getStringExtra(Intent.EXTRA_TEXT)

            if (streamUri == null && textContent.isNullOrBlank()) {
                Toast.makeText(this, "No content or file attached to share", Toast.LENGTH_SHORT).show()
                finish()
                return
            }

            setContent {
                FlammenwerferTheme {
                    Surface(
                        modifier = Modifier.fillMaxSize(),
                        color = MaterialTheme.colorScheme.background
                    ) {
                        SendToTargetPickerScreen(
                            streamUri = streamUri,
                            mimeType = type ?: "application/octet-stream",
                            onTargetSelected = { selectedTarget ->
                                if (streamUri != null) {
                                    handleUriShare(streamUri, type ?: "application/octet-stream", selectedTarget)
                                } else if (!textContent.isNullOrBlank()) {
                                    handleTextShare(textContent, selectedTarget)
                                }
                            },
                            onDismiss = { finish() }
                        )
                    }
                }
            }
        } else {
            finish()
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

        LaunchedEffect(streamUri) {
            if (streamUri != null) {
                withContext(Dispatchers.IO) {
                    try {
                        contentResolver.query(streamUri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                            if (cursor.moveToFirst()) {
                                val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                                if (nameIdx != -1) {
                                    val foundName = cursor.getString(nameIdx)
                                    if (!foundName.isNullOrBlank()) fileName = foundName
                                }
                            }
                        }
                    } catch (_: Exception) {}
                }
            }
        }

        LaunchedEffect(Unit) {
            isLoading = true
            val res = XIntentClient.fetchApiTags(applicationContext)
            if (res.success) {
                targets = XIntentClient.parseSendToTargets(res.responseBody)
            } else {
                statusMessage = "Could not reach desktop tags server: ${res.errorMessage ?: "Offline"}"
                val defaultApp = XIntentClient.getDefaultRemoteDevice(applicationContext)
                targets = listOf(
                    XIntentClient.SendToTarget(
                        appId = defaultApp,
                        name = "Desktop Target ($defaultApp)",
                        description = "Default Desktop XIntent Receiver"
                    )
                )
            }
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
                                color = MaterialTheme.colorScheme.onSurfaceVariant
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
                    .padding(16.dp)
            ) {
                if (isLoading) {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator()
                            Spacer(modifier = Modifier.height(16.dp))
                            Text("Discovering active desktop destinations (/api/tags)...")
                        }
                    }
                } else {
                    statusMessage?.let { msg ->
                        Text(
                            text = msg,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(bottom = 12.dp)
                        )
                    }

                    Text(
                        text = "Select Destination App:",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )

                    LazyColumn(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        items(targets) { target ->
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onTargetSelected(target.appId) },
                                colors = CardDefaults.cardColors(
                                    containerColor = MaterialTheme.colorScheme.surfaceVariant
                                )
                            ) {
                                Column(modifier = Modifier.padding(16.dp)) {
                                    Text(
                                        text = target.name,
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.Bold
                                    )
                                    Spacer(modifier = Modifier.height(4.dp))
                                    Text(
                                        text = "Target ID: ${target.appId}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.primary
                                    )
                                    if (target.description.isNotBlank()) {
                                        Spacer(modifier = Modifier.height(2.dp))
                                        Text(
                                            text = target.description,
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                    }
                                }
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(16.dp))
                    OutlinedButton(
                        onClick = onDismiss,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Cancel")
                    }
                }
            }
        }
    }

    private fun handleTextShare(text: String, targetApp: String) {
        Toast.makeText(applicationContext, "Saving shared text to desktop via $targetApp...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            val bytes = text.toByteArray(Charsets.UTF_8)
            val result = XIntentClient.sendSendToIntent(
                context = applicationContext,
                name = "shared_text.txt",
                type = "text/plain",
                size = bytes.size.toLong(),
                dataType = "text",
                data = text,
                targetApp = targetApp,
            )

            val msg = if (result.success) {
                "Saved text to $targetApp!"
            } else {
                "Failed to save text: ${result.errorMessage}"
            }
            Toast.makeText(applicationContext, msg, Toast.LENGTH_LONG).show()
            finish()
        }
    }

    private fun handleUriShare(uri: Uri, mimeType: String, targetApp: String) {
        Toast.makeText(applicationContext, "Reading file and saving to desktop via $targetApp...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            val (name, bytes, actualType) = withContext(Dispatchers.IO) {
                var fileName = "shared_file"
                val resolvedType = contentResolver.getType(uri) ?: mimeType

                try {
                    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (nameIdx != -1) {
                                val foundName = cursor.getString(nameIdx)
                                if (!foundName.isNullOrBlank()) {
                                    fileName = foundName
                                }
                            }
                        }
                    }
                } catch (_: Exception) {
                    uri.lastPathSegment?.let { if (it.isNotBlank()) fileName = it }
                }

                val fileBytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: ByteArray(0)
                Triple(fileName, fileBytes, resolvedType)
            }

            if (bytes.isNotEmpty()) {
                val isText = actualType.startsWith("text/")
                val dataType = if (isText) "text" else "base64"
                val encodedData = if (isText) {
                    String(bytes, Charsets.UTF_8)
                } else {
                    Base64.encodeToString(bytes, Base64.NO_WRAP)
                }

                val result = XIntentClient.sendSendToIntent(
                    context = applicationContext,
                    name = name,
                    type = actualType,
                    size = bytes.size.toLong(),
                    dataType = dataType,
                    data = encodedData,
                    targetApp = targetApp,
                    rawBytes = bytes,
                )

                val msg = if (result.success) {
                    "Saved $name (${bytes.size} bytes) to $targetApp!"
                } else {
                    "Failed to save $name: ${result.errorMessage}"
                }
                Toast.makeText(applicationContext, msg, Toast.LENGTH_LONG).show()
            } else {
                Toast.makeText(applicationContext, "Failed to read file from URI", Toast.LENGTH_SHORT).show()
            }
            finish()
        }
    }

    private fun handleGetContent() {
        Toast.makeText(applicationContext, "Pick file on Desktop PC...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            val targetApp = XIntentClient.getTargetApp(applicationContext, 1)
            val res = XIntentClient.sendPickFileIntent(applicationContext, targetApp = targetApp)

            if (res.success && res.rawBytes.isNotEmpty()) {
                val fileData = withContext(Dispatchers.IO) {
                    XIntentClient.extractFileFromPickFileResponse(res.rawBytes)
                }

                if (fileData != null && fileData.second.isNotEmpty()) {
                    val (fileName, bytes) = fileData
                    val cacheFile = File(cacheDir, fileName)
                    cacheFile.writeBytes(bytes)

                    val fileUri = FileProvider.getUriForFile(
                        applicationContext,
                        "${packageName}.fileprovider",
                        cacheFile
                    )

                    val resultIntent = Intent().apply {
                        data = fileUri
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    setResult(RESULT_OK, resultIntent)
                    Toast.makeText(applicationContext, "Picked $fileName from desktop!", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(applicationContext, "No file content received from desktop", Toast.LENGTH_SHORT).show()
                    setResult(RESULT_CANCELED)
                }
            } else {
                Toast.makeText(applicationContext, "Desktop file pick cancelled or failed", Toast.LENGTH_SHORT).show()
                setResult(RESULT_CANCELED)
            }
            finish()
        }
    }
}
