package org.xintent.flammenwerfer.storage

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.core.XIntentLogManager
import org.xintent.flammenwerfer.protocol.XIntentProtocolParser
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

object XIntentBlobClient {
    private const val TAG = "XIntentClient"

    fun unlinkXBlob(baseUrl: String, blobId: Long) {
        if (blobId <= 0) {
            Log.e(TAG, "Attempt to unlink invalid blobId $blobId")
            return
        }
        val hexBlobId = XIntentProtocolParser.formatBlobIdHex(blobId)
        try {
            val url = URL("$baseUrl/xblob/$hexBlobId")
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "DELETE"
                connectTimeout = 5000
                readTimeout = 5000
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }
            val responseCode = connection.responseCode
            Log.i(TAG, "Unlinked xblob $hexBlobId (u32: $blobId) at $baseUrl [$responseCode]")
        } catch (e: Exception) {
            Log.e(TAG, "Error unlinking xblob $hexBlobId (u32: $blobId) at $baseUrl", e)
        }
    }

    suspend fun uploadXBlob(
        context: Context,
        name: String,
        type: String,
        inputStream: InputStream,
        size: Long,
        onProgress: ((bytesWritten: Long, totalBytes: Long) -> Unit)? = null,
    ): String? = withContext(Dispatchers.IO) {
        val baseUrl = XIntentPreferences.getServerUrl(context)
        val fullUrl = "$baseUrl/xblob"

        val logPrefix = "[XBlob Upload]"
        XIntentLogManager.addLog("$logPrefix Uploading stream $name ($type, $size bytes)...")

        try {
            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "PUT"
                doOutput = true
                connectTimeout = 15000
                readTimeout = 60000
                setRequestProperty("Content-Type", type)
                if (size >= 0) {
                    setFixedLengthStreamingMode(size)
                    setRequestProperty("Content-Length", size.toString())
                }
                setRequestProperty("Content-Disposition", "attachment; filename=\"$name\"")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            connection.outputStream.use { os ->
                inputStream.use { input ->
                    val buffer = ByteArray(8192)
                    var bytesWritten = 0L
                    var bytesRead: Int
                    while (input.read(buffer).also { bytesRead = it } != -1) {
                        os.write(buffer, 0, bytesRead)
                        bytesWritten += bytesRead
                        if (size > 0 && onProgress != null) {
                            onProgress(bytesWritten, size)
                        }
                    }
                }
                os.flush()
            }

            val responseCode = connection.responseCode
            if (responseCode in 200..299) {
                val responseText = connection.inputStream.bufferedReader().use { it.readText() }
                val jsonObjects = XIntentProtocolParser.extractJsonObjects(responseText)
                var blobIdHex = if (jsonObjects.isNotEmpty()) {
                    val obj = jsonObjects.first()
                    obj.optString("blobId", obj.optString("blob", ""))
                } else {
                    ""
                }
                if (blobIdHex.isBlank()) {
                    blobIdHex = connection.getHeaderField("X-Blob-Id") ?: ""
                }
                if (blobIdHex.isNotBlank()) {
                    XIntentLogManager.addLog("$logPrefix SUCCESS -> Blob ID $blobIdHex")
                    return@withContext blobIdHex
                }
            }
            XIntentLogManager.addLog("$logPrefix FAILED ($responseCode)")
        } catch (e: Exception) {
            Log.e(TAG, "Error uploading XBlob stream to $fullUrl", e)
            XIntentLogManager.addLog("$logPrefix ERROR: ${e.javaClass.simpleName}: ${e.message}")
        }
        return@withContext null
    }

    suspend fun uploadXBlob(
        context: Context,
        name: String,
        type: String,
        rawBytes: ByteArray,
    ): String? = uploadXBlob(context, name, type, rawBytes.inputStream(), rawBytes.size.toLong())
}
