package org.xintent.flammenwerfer

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import android.widget.Toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.xintent.flammenwerfer.protocol.XIntentProtocolParser

data class ResolvedMediaMetadata(
    val fileName: String,
    val fileSize: Long,
    val mimeType: String,
    val isUriSchemeHttp: Boolean,
)

object PlayMediaController {

    fun extractMediaUri(intent: Intent?): Uri? {
        if (intent == null) return null
        if (intent.action != Intent.ACTION_SEND) return intent.data
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: intent.data
        } else {
            @Suppress("DEPRECATION")
            (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri) ?: intent.data
        }
    }

    suspend fun fetchTargets(context: Context): List<XIntentClient.MediaPlayTarget> {
        val res = XIntentCatalogParser.fetchApiTags(context)
        if (res.success) {
            return XIntentCatalogParser.parseMediaPlayTargets(res.responseBody)
        }
        return listOf(
            XIntentClient.MediaPlayTarget(
                appId = "user-desktop",
                name = "User Desktop PC",
                accept = "*/*",
                description = "Default Desktop XIntent Device",
            )
        )
    }

    suspend fun resolveMediaMetadata(context: Context, mediaUri: Uri?, initialMimeType: String): ResolvedMediaMetadata {
        if (mediaUri == null) {
            return ResolvedMediaMetadata("No media URI provided", 0L, initialMimeType, false)
        }
        val scheme = mediaUri.scheme?.lowercase()
        val isHttp = scheme == "http" || scheme == "https"
        return withContext(Dispatchers.IO) {
            var name = "video_file"
            var size = 0L
            val resolvedType = context.contentResolver.getType(mediaUri) ?: initialMimeType
            try {
                context.contentResolver.query(
                    mediaUri,
                    arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                    null,
                    null,
                    null,
                )?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val sizeIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).let { cursor.getColumnIndex(OpenableColumns.SIZE) }
                        if (nameIdx != -1) {
                            cursor.getString(nameIdx)?.takeIf { it.isNotBlank() }?.let { name = it }
                        }
                        if (sizeIdx != -1) size = cursor.getLong(sizeIdx)
                    }
                }
            } catch (_: Exception) {
                mediaUri.lastPathSegment?.takeIf { it.isNotBlank() }?.let { name = it }
            }
            ResolvedMediaMetadata(name, size, resolvedType, isHttp)
        }
    }

    private suspend fun loadPayloadData(context: Context, mediaUri: Uri, isHttp: Boolean): Pair<String, String> {
        if (isHttp) return Pair("url", mediaUri.toString())
        val bytes = withContext(Dispatchers.IO) {
            context.contentResolver.openInputStream(mediaUri)?.use { it.readBytes() } ?: ByteArray(0)
        }
        return Pair("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }

    suspend fun dispatchMediaPlay(
        context: Context,
        mediaUri: Uri,
        metadata: ResolvedMediaMetadata,
        target: XIntentClient.MediaPlayTarget,
        transcode: Boolean,
        onStatusUpdate: (String) -> Unit,
        onClose: () -> Unit,
    ) {
        val initialStatus = if (transcode) {
            "Transcoding ${metadata.fileName} via cool-transcoder for ${target.name}..."
        } else {
            "Sending ${metadata.fileName} to ${target.name}..."
        }
        onStatusUpdate(initialStatus)

        val (dataType, dataVal) = loadPayloadData(context, mediaUri, metadata.isUriSchemeHttp)
        val effectiveSize = if (metadata.fileSize > 0) metadata.fileSize else dataVal.length.toLong()

        if (transcode) {
            dispatchTranscodedPlay(context, metadata, effectiveSize, dataType, dataVal, target, onStatusUpdate, onClose)
        } else {
            dispatchDirectPlay(context, metadata, effectiveSize, dataType, dataVal, target, onStatusUpdate, onClose)
        }
    }

    private suspend fun dispatchDirectPlay(
        context: Context,
        metadata: ResolvedMediaMetadata,
        effectiveSize: Long,
        dataType: String,
        dataVal: String,
        target: XIntentClient.MediaPlayTarget,
        onStatusUpdate: (String) -> Unit,
        onClose: () -> Unit,
    ) {
        val result = XIntentDispatcher.sendMediaPlayIntent(
            context = context,
            name = metadata.fileName,
            type = metadata.mimeType,
            size = effectiveSize,
            dataType = dataType,
            data = dataVal,
            targetApp = target.appId,
            title = metadata.fileName,
        )
        if (result.success) {
            Toast.makeText(context, "Playing ${metadata.fileName} on ${target.name}!", Toast.LENGTH_LONG).show()
            onClose()
        } else {
            onStatusUpdate("Error: ${result.errorMessage}")
            Toast.makeText(context, "Failed to play: ${result.errorMessage}", Toast.LENGTH_LONG).show()
        }
    }

    private suspend fun dispatchTranscodedPlay(
        context: Context,
        metadata: ResolvedMediaMetadata,
        effectiveSize: Long,
        dataType: String,
        dataVal: String,
        target: XIntentClient.MediaPlayTarget,
        onStatusUpdate: (String) -> Unit,
        onClose: () -> Unit,
    ) {
        val transcodeRes = XIntentDispatcher.sendMediaTranscodeIntent(
            context = context,
            name = metadata.fileName,
            type = metadata.mimeType,
            size = effectiveSize,
            dataType = dataType,
            data = dataVal,
            targetAccept = target.accept,
            targetApp = "cool-transcoder",
        )
        if (!transcodeRes.success) {
            onStatusUpdate("Transcode failed: ${transcodeRes.errorMessage}")
            Toast.makeText(context, "Transcode failed: ${transcodeRes.errorMessage}", Toast.LENGTH_LONG).show()
            return
        }

        val resJson = XIntentProtocolParser.extractJsonObjects(transcodeRes.responseBody).firstOrNull()
        val transcodedUrl = resJson?.optString("url", "").orEmpty()
        val transcodedMime = resJson?.optString("mimeType", metadata.mimeType) ?: metadata.mimeType
        if (transcodedUrl.isBlank()) {
            onStatusUpdate("Transcoder returned no stream URL")
            Toast.makeText(context, "Transcode failed: No stream URL returned", Toast.LENGTH_LONG).show()
            return
        }

        onStatusUpdate("Transcoding started -> Streaming to ${target.name}...")
        val playRes = XIntentDispatcher.sendMediaPlayIntent(
            context = context,
            name = metadata.fileName,
            type = transcodedMime,
            size = 0L,
            dataType = "url",
            data = transcodedUrl,
            targetApp = target.appId,
            title = metadata.fileName,
        )
        if (playRes.success) {
            Toast.makeText(context, "Streaming transcoded media to ${target.name}!", Toast.LENGTH_LONG).show()
            onClose()
        } else {
            onStatusUpdate("Error playing transcoded stream: ${playRes.errorMessage}")
            Toast.makeText(context, "Failed to play: ${playRes.errorMessage}", Toast.LENGTH_LONG).show()
        }
    }
}
