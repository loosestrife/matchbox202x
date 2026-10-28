package org.xintent.flammenwerfer

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.protocol.XIntentProtocolParser
import java.io.File

object SendIntentController {

    fun extractStreamUri(intent: Intent?): Uri? {
        if (intent == null) return null
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
    }

    suspend fun queryDisplayName(context: Context, uri: Uri?): String? {
        if (uri == null) return null
        return withContext(Dispatchers.IO) {
            try {
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (nameIdx != -1) cursor.getString(nameIdx)?.takeIf { it.isNotBlank() } else null
                    } else null
                }
            } catch (_: Exception) {
                null
            }
        }
    }

    suspend fun fetchSendToTargets(context: Context): Pair<List<XIntentClient.SendToTarget>, String?> {
        val res = XIntentCatalogParser.fetchApiTags(context)
        if (res.success) {
            return Pair(XIntentCatalogParser.parseSendToTargets(res.responseBody), null)
        }
        val errMsg = "Could not reach desktop tags server: ${res.errorMessage.ifBlank { "Offline" }}"
        val defaultApp = XIntentPreferences.getDefaultRemoteDevice(context)
        val fallback = listOf(
            XIntentClient.SendToTarget(
                appId = defaultApp,
                name = "Desktop Target ($defaultApp)",
                description = "Default Desktop XIntent Receiver",
            )
        )
        return Pair(fallback, errMsg)
    }

    suspend fun performTextShare(context: Context, text: String, targetApp: String) {
        Toast.makeText(context, "Saving shared text to desktop via $targetApp...", Toast.LENGTH_SHORT).show()
        val bytes = text.toByteArray(Charsets.UTF_8)
        val result = XIntentDispatcher.sendSendToIntent(
            context = context,
            name = "shared_text.txt",
            type = "text/plain",
            size = bytes.size.toLong(),
            dataType = "text",
            data = text,
            targetApp = targetApp,
        )
        val msg = if (result.success) "Saved text to $targetApp!" else "Failed to save text: ${result.errorMessage}"
        Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
    }

    private suspend fun resolveFileDetails(context: Context, uri: Uri, fallbackMime: String): Triple<String, Long, String> =
        withContext(Dispatchers.IO) {
            var fileName = uri.lastPathSegment?.takeIf { it.isNotBlank() } ?: "shared_file"
            var fileSize = -1L
            val resolvedType = context.contentResolver.getType(uri) ?: fallbackMime
            try {
                context.contentResolver.query(
                    uri,
                    arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                    null,
                    null,
                    null,
                )?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (nameIdx != -1) {
                            cursor.getString(nameIdx)?.takeIf { it.isNotBlank() }?.let { fileName = it }
                        }
                        val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (sizeIdx != -1) fileSize = cursor.getLong(sizeIdx)
                    }
                }
            } catch (_: Exception) {}
            Triple(fileName, fileSize, resolvedType)
        }

    suspend fun performUriShare(
        context: Context,
        uri: Uri,
        mimeType: String,
        targetApp: String,
        onProgress: (Float, String) -> Unit,
    ) {
        Toast.makeText(context, "Reading file and saving to desktop via $targetApp...", Toast.LENGTH_SHORT).show()
        val (name, fileSize, actualType) = resolveFileDetails(context, uri, mimeType)
        val inputStream = context.contentResolver.openInputStream(uri)
        if (inputStream == null) {
            Toast.makeText(context, "Failed to read file from URI", Toast.LENGTH_SHORT).show()
            return
        }

        val dataType = if (actualType.startsWith("text/")) "text" else "base64"
        val result = XIntentDispatcher.sendSendToIntent(
            context = context,
            name = name,
            type = actualType,
            size = fileSize,
            dataType = dataType,
            data = "",
            targetApp = targetApp,
            inputStream = inputStream,
            onProgress = { written, total ->
                val progress = if (total > 0) written.toFloat() / total.toFloat() else 0f
                val mbWritten = written / (1024 * 1024)
                val mbTotal = total / (1024 * 1024)
                onProgress(progress, "Uploading $name (${mbWritten}MB / ${mbTotal}MB)...")
            },
        )
        val msg = if (result.success) "Saved $name to $targetApp!" else "Failed to save $name: ${result.errorMessage}"
        Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
    }

    suspend fun performGetContent(activity: Activity) {
        val appContext = activity.applicationContext
        Toast.makeText(appContext, "Pick file on Desktop PC...", Toast.LENGTH_SHORT).show()
        val targetApp = XIntentPreferences.getTargetApp(appContext, 1)
        val res = XIntentDispatcher.sendPickFileIntent(appContext, targetApp = targetApp)

        if (!res.success || res.rawBytes.isEmpty()) {
            Toast.makeText(appContext, "Desktop file pick cancelled or failed", Toast.LENGTH_SHORT).show()
            activity.setResult(Activity.RESULT_CANCELED)
            return
        }

        val fileData = withContext(Dispatchers.IO) {
            XIntentProtocolParser.extractFileFromPickFileResponse(res.rawBytes)
        }
        if (fileData == null || fileData.second.isEmpty()) {
            Toast.makeText(appContext, "No file content received from desktop", Toast.LENGTH_SHORT).show()
            activity.setResult(Activity.RESULT_CANCELED)
            return
        }

        val (fileName, bytes) = fileData
        val cacheFile = File(activity.cacheDir, fileName).apply { writeBytes(bytes) }
        val fileUri = FileProvider.getUriForFile(appContext, "${activity.packageName}.fileprovider", cacheFile)
        val resultIntent = Intent().apply {
            data = fileUri
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.setResult(Activity.RESULT_OK, resultIntent)
        Toast.makeText(appContext, "Picked $fileName from desktop!", Toast.LENGTH_SHORT).show()
    }
}
