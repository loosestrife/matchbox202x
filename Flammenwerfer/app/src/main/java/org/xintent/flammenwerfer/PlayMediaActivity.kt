package org.xintent.flammenwerfer

import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.xintent.flammenwerfer.ui.theme.FlammenwerferTheme

class PlayMediaActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val mediaUri = PlayMediaController.extractMediaUri(intent)
        val initialMime = intent.type ?: "video/*"

        setContent {
            FlammenwerferTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    PlayMediaScreen(
                        modifier = Modifier.padding(innerPadding),
                        mediaUri = mediaUri,
                        initialMimeType = initialMime,
                        onClose = { finish() },
                    )
                }
            }
        }
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

    var metadata by remember {
        mutableStateOf(ResolvedMediaMetadata("Loading file...", 0L, initialMimeType, false))
    }
    var targets by remember { mutableStateOf<List<XIntentClient.MediaPlayTarget>>(emptyList()) }
    var isLoadingTargets by remember { mutableStateOf(true) }
    var isDispatching by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf<String?>(null) }

    fun refreshTargets() {
        coroutineScope.launch {
            isLoadingTargets = true
            targets = PlayMediaController.fetchTargets(context)
            isLoadingTargets = false
        }
    }

    LaunchedEffect(mediaUri) {
        metadata = PlayMediaController.resolveMediaMetadata(context, mediaUri, initialMimeType)
        refreshTargets()
    }

    fun onTriggerPlay(target: XIntentClient.MediaPlayTarget, transcode: Boolean) {
        if (mediaUri == null) {
            Toast.makeText(context, "No media file selected", Toast.LENGTH_SHORT).show()
            return
        }
        coroutineScope.launch {
            isDispatching = true
            PlayMediaController.dispatchMediaPlay(
                context = context,
                mediaUri = mediaUri,
                metadata = metadata,
                target = target,
                transcode = transcode,
                onStatusUpdate = { statusMessage = it },
                onClose = onClose,
            )
            isDispatching = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("XIntent Media Output") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                ),
            )
        }
    ) { padding ->
        Column(
            modifier = modifier
                .padding(padding)
                .fillMaxSize()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SelectedMediaCard(metadata)

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Discovered Network Targets", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                OutlinedButton(onClick = { refreshTargets() }, enabled = !isLoadingTargets && !isDispatching) {
                    Text("Refresh")
                }
            }

            statusMessage?.let { msg ->
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
                ) {
                    Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (isDispatching) {
                            CircularProgressIndicator(modifier = Modifier.height(24.dp).width(24.dp))
                            Spacer(modifier = Modifier.width(12.dp))
                        }
                        Text(msg, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            MediaTargetsListSection(
                isLoadingTargets = isLoadingTargets,
                isDispatching = isDispatching,
                targets = targets,
                modifier = Modifier.fillMaxWidth().weight(1f),
                onTriggerPlay = ::onTriggerPlay,
            )
        }
    }
}

@Composable
private fun SelectedMediaCard(metadata: ResolvedMediaMetadata) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("Selected Media", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Spacer(modifier = Modifier.height(4.dp))
            Text(metadata.fileName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(4.dp))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Type: ${metadata.mimeType}", style = MaterialTheme.typography.bodySmall)
                if (metadata.fileSize > 0) {
                    Text("${metadata.fileSize / (1024 * 1024)} MB", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun MediaTargetsListSection(
    isLoadingTargets: Boolean,
    isDispatching: Boolean,
    targets: List<XIntentClient.MediaPlayTarget>,
    modifier: Modifier = Modifier,
    onTriggerPlay: (XIntentClient.MediaPlayTarget, Boolean) -> Unit,
) {
    if (isLoadingTargets) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(32.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator()
            Spacer(modifier = Modifier.width(16.dp))
            Text("Scanning network for media.Play outputs...")
        }
        return
    }
    if (targets.isEmpty()) {
        Text("No network media outputs discovered. Ensure XIntent server or DLNA daemon is running.")
        return
    }
    LazyColumn(modifier = modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items(targets) { target ->
            Card(
                modifier = Modifier.fillMaxWidth(),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
            ) {
                Row(
                    modifier = Modifier.padding(16.dp).fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(target.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text(
                            "App ID: ${target.appId}",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.outline,
                        )
                        Spacer(modifier = Modifier.height(2.dp))
                        Text(
                            "Accept: ${target.accept}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.tertiary,
                        )
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp), horizontalAlignment = Alignment.End) {
                        Button(
                            onClick = { onTriggerPlay(target, false) },
                            enabled = !isDispatching,
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
                        ) {
                            Text("Play")
                        }
                        OutlinedButton(onClick = { onTriggerPlay(target, true) }, enabled = !isDispatching) {
                            Text("Transcode")
                        }
                    }
                }
            }
        }
    }
}
