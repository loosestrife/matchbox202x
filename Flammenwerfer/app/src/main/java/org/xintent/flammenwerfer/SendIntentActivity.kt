package org.xintent.flammenwerfer

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class SendIntentActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val action = intent?.action
        val type = intent?.type

        if (action == Intent.ACTION_GET_CONTENT || action == Intent.ACTION_OPEN_DOCUMENT) {
            handleGetContent()
        } else if (action == Intent.ACTION_SEND) {
            val streamUri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_STREAM)
            }
            val textContent = intent.getStringExtra(Intent.EXTRA_TEXT)
            val targetApp = XIntentClient.getTargetApp(applicationContext, 1)

            if (streamUri != null) {
                handleUriShare(streamUri, type ?: "application/octet-stream", targetApp)
            } else if (!textContent.isNullOrBlank()) {
                handleTextShare(textContent, targetApp)
            } else {
                Toast.makeText(this, "No content or file attached to share", Toast.LENGTH_SHORT).show()
                finish()
            }
        } else {
            finish()
        }
    }

    private fun handleTextShare(text: String, targetApp: String) {
        Toast.makeText(applicationContext, "Saving shared text to desktop via $targetApp...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            val bytes = text.toByteArray(Charsets.UTF_8)
            val result = XIntentClient.sendSaveAsIntent(
                context = applicationContext,
                name = "shared_text.txt",
                type = "text/plain",
                size = bytes.size.toLong(),
                dataType = "text",
                data = text,
                targetApp = targetApp,
            )

            val msg = if (result.success) {
                "Saved text to desktop!"
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

                val result = XIntentClient.sendSaveAsIntent(
                    context = applicationContext,
                    name = name,
                    type = actualType,
                    size = bytes.size.toLong(),
                    dataType = dataType,
                    data = encodedData,
                    targetApp = targetApp,
                )

                val msg = if (result.success) {
                    "Saved $name (${bytes.size} bytes) to desktop!"
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
