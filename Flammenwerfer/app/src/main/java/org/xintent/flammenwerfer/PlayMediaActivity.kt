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
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.xintent.flammenwerfer.ui.theme.FlammenwerferTheme

class PlayMediaActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val mediaUri = extractMediaUri(intent)
        val initialMime = intent.type ?: "video/*"

        setContent {
            FlammenwerferTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    PlayMediaScreen(
                        modifier = Modifier.padding(innerPadding),
                        mediaUri = mediaUri,
                        initialMimeType = initialMime,
                        onClose = { finish() }
                    )
                }
            }
        }
    }

    private fun extractMediaUri(intent: Intent?): Uri? {
        if (intent == null) return null
        val action = intent.action
        if (action == Intent.ACTION_VIEW) {
            return intent.data
        } else if (action == Intent.ACTION_SEND) {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: intent.data
            } else {
                @Suppress("DEPRECATION")
                (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri) ?: intent.data
            }
        }
        return intent.data
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlayMediaScreen(
    modifier: Modifier = Modifier,
    mediaUri: Uri?,
    initialMimeType: String,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()

    var fileName by remember { mutableStateOf("Loading file...") }
    var fileSize by remember { mutableStateOf(0L) }
    var mimeType by remember { mutableStateOf(initialMimeType) }
    var isUriSchemeHttp by remember { mutableStateOf(false) }

    var targets by remember { mutableStateOf<List<XIntentClient.MediaPlayTarget>>(emptyList()) }
    var isLoadingTargets by remember { mutableStateOf(true) }
    var isDispatching by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf<String?>(null) }

    fun refreshTargets() {
        coroutineScope.launch {
            isLoadingTargets = true
            val res = XIntentClient.fetchApiTags(context)
            if (res.success) {
                targets = XIntentClient.parseMediaPlayTargets(res.responseBody)
            } else {
                targets = listOf(
                    XIntentClient.MediaPlayTarget(
                        appId = "user-desktop",
                        name = "User Desktop PC",
                        accept = "*/*",
                        description = "Default Desktop XIntent Device"
                    )
                )
            }
            isLoadingTargets = false
        }
    }

    LaunchedEffect(mediaUri) {
        if (mediaUri != null) {
            val scheme = mediaUri.scheme?.lowercase()
            isUriSchemeHttp = scheme == "http" || scheme == "https"

            withContext(Dispatchers.IO) {
                var name = "video_file"
                var size = 0L
                val resolvedType = context.contentResolver.getType(mediaUri) ?: initialMimeType

                try {
                    context.contentResolver.query(mediaUri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (nameIdx != -1) {
                                val foundName = cursor.getString(nameIdx)
                                if (!foundName.isNullOrBlank()) name = foundName
                            }
                            if (sizeIdx != -1) {
                                size = cursor.getLong(sizeIdx)
                            }
                        }
                    }
                } catch (_: Exception) {
                    mediaUri.lastPathSegment?.let { if (it.isNotBlank()) name = it }
                }

                fileName = name
                fileSize = size
                mimeType = resolvedType
            }
        } else {
            fileName = "No media URI provided"
        }

        refreshTargets()
    }

    fun dispatchMediaPlay(target: XIntentClient.MediaPlayTarget, transcode: Boolean = false) {
        if (mediaUri == null) {
            Toast.makeText(context, "No media file selected", Toast.LENGTH_SHORT).show()
            return
        }

        coroutineScope.launch {
            isDispatching = true
            statusMessage = if (transcode) "Transcoding $fileName via cool-transcoder for ${target.name}..." else "Sending $fileName to ${target.name}..."

            val (dataType, dataVal) = if (isUriSchemeHttp) {
                Pair("url", mediaUri.toString())
            } else {
                val bytes = withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(mediaUri)?.use { it.readBytes() } ?: ByteArray(0)
                }
                val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
                Pair("base64", encoded)
            }

            if (transcode) {
                val transcodeRes = XIntentClient.sendMediaTranscodeIntent(
                    context = context,
                    name = fileName,
                    type = mimeType,
                    size = if (fileSize > 0) fileSize else dataVal.length.toLong(),
                    dataType = dataType,
                    data = dataVal,
                    targetAccept = target.accept,
                    targetApp = "cool-transcoder",
                )

                if (transcodeRes.success) {
                    val resJson = XIntentClient.extractJsonObjects(transcodeRes.responseBody).firstOrNull()
                    val transcodedUrl = resJson?.optString("url", "") ?: ""
                    val transcodedMime = resJson?.optString("mimeType", mimeType) ?: mimeType

                    if (transcodedUrl.isNotBlank()) {
                        statusMessage = "Transcoding started -> Streaming to ${target.name}..."
                        val playRes = XIntentClient.sendMediaPlayIntent(
                            context = context,
                            name = fileName,
                            type = transcodedMime,
                            size = 0L,
                            dataType = "url",
                            data = transcodedUrl,
                            targetApp = target.appId,
                            title = fileName,
                        )

                        isDispatching = false
                        if (playRes.success) {
                            Toast.makeText(context, "Streaming transcoded media to ${target.name}!", Toast.LENGTH_LONG).show()
                            onClose()
                        } else {
                            statusMessage = "Error playing transcoded stream: ${playRes.errorMessage}"
                            Toast.makeText(context, "Failed to play: ${playRes.errorMessage}", Toast.LENGTH_LONG).show()
                        }
                    } else {
                        isDispatching = false
                        statusMessage = "Transcoder returned no stream URL"
                        Toast.makeText(context, "Transcode failed: No stream URL returned", Toast.LENGTH_LONG).show()
                    }
                } else {
                    isDispatching = false
                    statusMessage = "Transcode failed: ${transcodeRes.errorMessage}"
                    Toast.makeText(context, "Transcode failed: ${transcodeRes.errorMessage}", Toast.LENGTH_LONG).show()
                }
            } else {
                val result = XIntentClient.sendMediaPlayIntent(
                    context = context,
                    name = fileName,
                    type = mimeType,
                    size = if (fileSize > 0) fileSize else dataVal.length.toLong(),
                    dataType = dataType,
                    data = dataVal,
                    targetApp = target.appId,
                    title = fileName,
                )

                isDispatching = false
                if (result.success) {
                    Toast.makeText(context, "Playing $fileName on ${target.name}!", Toast.LENGTH_LONG).show()
                    onClose()
                } else {
                    statusMessage = "Error: ${result.errorMessage}"
                    Toast.makeText(context, "Failed to play: ${result.errorMessage}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("XIntent Media Output") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            )
        }
    ) { padding ->
        Column(
            modifier = modifier
                .padding(padding)
                .fillMaxSize()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Selected Media Card
            Card(
                modifier = Modifier.fillMaxWidth(),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Selected Media",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.primary
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = fileName,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "Type: $mimeType",
                            style = MaterialTheme.typography.bodySmall
                        )
                        if (fileSize > 0) {
                            Text(
                                text = "${fileSize / (1024 * 1024)} MB",
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }
                }
            }

            // Header for network targets
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Discovered Network Targets",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                OutlinedButton(
                    onClick = { refreshTargets() },
                    enabled = !isLoadingTargets && !isDispatching
                ) {
                    Text("Refresh")
                }
            }

            if (statusMessage != null) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        if (isDispatching) {
                            CircularProgressIndicator(modifier = Modifier.height(24.dp).width(24.dp))
                            Spacer(modifier = Modifier.width(12.dp))
                        }
                        Text(
                            text = statusMessage ?: "",
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                }
            }

            if (isLoadingTargets) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(32.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    CircularProgressIndicator()
                    Spacer(modifier = Modifier.width(16.dp))
                    Text("Scanning network for media.Play outputs...")
                }
            } else if (targets.isEmpty()) {
                Text("No network media outputs discovered. Ensure XIntent server or DLNA daemon is running.")
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    items(targets) { target ->
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
                        ) {
                            Row(
                                modifier = Modifier.padding(16.dp).fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = target.name,
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.SemiBold
                                    )
                                    Text(
                                        text = "App ID: ${target.appId}",
                                        style = MaterialTheme.typography.bodySmall,
                                        fontFamily = FontFamily.Monospace,
                                        color = MaterialTheme.colorScheme.outline
                                    )
                                    Spacer(modifier = Modifier.height(2.dp))
                                    Text(
                                        text = "Accept: ${target.accept}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.tertiary
                                    )
                                }
                                Spacer(modifier = Modifier.width(8.dp))
                                Column(
                                    verticalArrangement = Arrangement.spacedBy(4.dp),
                                    horizontalAlignment = Alignment.End
                                ) {
                                    Button(
                                        onClick = { dispatchMediaPlay(target, transcode = false) },
                                        enabled = !isDispatching,
                                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
                                    ) {
                                        Text("Play")
                                    }
                                    OutlinedButton(
                                        onClick = { dispatchMediaPlay(target, transcode = true) },
                                        enabled = !isDispatching
                                    ) {
                                        Text("Transcode")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
