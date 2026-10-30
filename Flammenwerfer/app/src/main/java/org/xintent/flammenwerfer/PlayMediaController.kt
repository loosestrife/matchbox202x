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
        if (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE) {
            return SendIntentController.extractStreamUri(intent)
        }
        return intent.data ?: SendIntentController.extractStreamUri(intent)
    }

    suspend fun fetchTargets(context: Context): List<XIntentClient.MediaPlayTarget> {
        val res = XIntentCatalogParser.fetchApiTags(context)
        if (res.success) {
            val targets = XIntentCatalogParser.parseMediaPlayTargets(res.responseBody)
            if (targets.isNotEmpty()) return targets
            XIntentDispatcher.sendFindDevicesIntent(context)
            val retryRes = XIntentCatalogParser.fetchApiTags(context)
            if (retryRes.success) {
                return XIntentCatalogParser.parseMediaPlayTargets(retryRes.responseBody)
            }
            return targets
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
                        val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (nameIdx != -1) {
                            cursor.getString(nameIdx)?.takeIf { it.isNotBlank() }?.let { name = it }
                        }
                        if (sizeIdx != -1 && !cursor.isNull(sizeIdx)) size = cursor.getLong(sizeIdx)
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
        onProgressUpdate: (Float?) -> Unit = {},
        onClose: () -> Unit,
    ) {
        val initialStatus = if (transcode) {
            "Transcoding ${metadata.fileName} via cool-transcoder for ${target.name}..."
        } else {
            "Sending ${metadata.fileName} to ${target.name}..."
        }
        onStatusUpdate(initialStatus)
        onProgressUpdate(0f)

        val effectiveSize = if (metadata.fileSize > 0) metadata.fileSize else 0L

        if (transcode) {
            dispatchTranscodedPlay(context, mediaUri, metadata, effectiveSize, target, onStatusUpdate, onProgressUpdate, onClose)
        } else {
            dispatchDirectPlay(context, mediaUri, metadata, effectiveSize, target, onStatusUpdate, onProgressUpdate, onClose)
        }
    }

    private suspend fun dispatchDirectPlay(
        context: Context,
        mediaUri: Uri,
        metadata: ResolvedMediaMetadata,
        effectiveSize: Long,
        target: XIntentClient.MediaPlayTarget,
        onStatusUpdate: (String) -> Unit,
        onProgressUpdate: (Float?) -> Unit,
        onClose: () -> Unit,
    ) {
        val isHttp = metadata.isUriSchemeHttp
        val inputStream = if (!isHttp) {
            withContext(Dispatchers.IO) { context.contentResolver.openInputStream(mediaUri) }
        } else null

        val result = XIntentDispatcher.sendMediaPlayIntent(
            context = context,
            name = metadata.fileName,
            type = metadata.mimeType,
            size = effectiveSize,
            dataType = if (isHttp) "url" else "base64",
            data = if (isHttp) mediaUri.toString() else "",
            targetApp = target.appId,
            title = metadata.fileName,
            inputStream = inputStream,
            onUploadProgress = { written, total ->
                val pct = if (total > 0) (written.toFloat() / total.toFloat()).coerceIn(0f, 1f) else 0f
                val mbWritten = written / (1024 * 1024)
                val mbTotal = total / (1024 * 1024)
                onProgressUpdate(pct)
                onStatusUpdate("Uploading ${metadata.fileName} (${mbWritten}MB / ${mbTotal}MB)...")
            },
        )
        onProgressUpdate(null)
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
        mediaUri: Uri,
        metadata: ResolvedMediaMetadata,
        effectiveSize: Long,
        target: XIntentClient.MediaPlayTarget,
        onStatusUpdate: (String) -> Unit,
        onProgressUpdate: (Float?) -> Unit,
        onClose: () -> Unit,
    ) {
        val isHttp = metadata.isUriSchemeHttp
        val inputStream = if (!isHttp) {
            withContext(Dispatchers.IO) { context.contentResolver.openInputStream(mediaUri) }
        } else null

        val transcodeRes = XIntentDispatcher.sendMediaTranscodeIntent(
            context = context,
            name = metadata.fileName,
            type = metadata.mimeType,
            size = effectiveSize,
            dataType = if (isHttp) "url" else "base64",
            data = if (isHttp) mediaUri.toString() else "",
            targetAccept = target.accept,
            targetApp = "cool-transcoder",
            inputStream = inputStream,
            preferMinimal = true,
            onUploadProgress = { written, total ->
                val pct = if (total > 0) (written.toFloat() / total.toFloat()).coerceIn(0f, 1f) else 0f
                val mbWritten = written / (1024 * 1024)
                val mbTotal = total / (1024 * 1024)
                onProgressUpdate(pct)
                onStatusUpdate("Uploading ${metadata.fileName} (${mbWritten}MB / ${mbTotal}MB)...")
            },
            onTranscodeProgress = { pct ->
                onProgressUpdate(pct)
                onStatusUpdate("Transcoding ${metadata.fileName}: ${(pct * 100).toInt()}%...")
            },
        )
        if (!transcodeRes.success) {
            onProgressUpdate(null)
            onStatusUpdate("Transcode failed: ${transcodeRes.errorMessage}")
            Toast.makeText(context, "Transcode failed: ${transcodeRes.errorMessage}", Toast.LENGTH_LONG).show()
            return
        }

        val resJson = XIntentProtocolParser.extractJsonObjects(transcodeRes.responseBody).lastOrNull()
        val rawBlobId = transcodeRes.attachedBlobId.takeIf { it.isNotBlank() }
        val transcodedUrl = resJson?.optString("url", "").orEmpty()
        val transcodedMime = resJson?.optString("mimeType", metadata.mimeType) ?: metadata.mimeType

        if (rawBlobId.isNullOrBlank() && transcodedUrl.isBlank()) {
            onProgressUpdate(null)
            onStatusUpdate("Transcoder returned no XBlob ID or stream URL")
            Toast.makeText(context, "Transcode failed: No blob ID returned", Toast.LENGTH_LONG).show()
            return
        }

        onProgressUpdate(1f)
        onStatusUpdate("Transcode complete -> Playing Blob ${rawBlobId ?: transcodedUrl} on ${target.name}...")
        val playRes = XIntentDispatcher.sendMediaPlayIntent(
            context = context,
            name = metadata.fileName,
            type = transcodedMime,
            size = 0L,
            dataType = if (rawBlobId.isNullOrBlank()) "url" else "",
            data = if (rawBlobId.isNullOrBlank()) transcodedUrl else "",
            targetApp = target.appId,
            title = metadata.fileName,
            dataBlob = rawBlobId,
            xblobType = if (!rawBlobId.isNullOrBlank()) "Blob" else null,
        )
        onProgressUpdate(null)
        if (playRes.success) {
            Toast.makeText(context, "Playing transcoded Blob on ${target.name}!", Toast.LENGTH_LONG).show()
            onClose()
        } else {
            onStatusUpdate("Error playing transcoded Blob: ${playRes.errorMessage}")
            Toast.makeText(context, "Failed to play: ${playRes.errorMessage}", Toast.LENGTH_LONG).show()
        }
    }
}
