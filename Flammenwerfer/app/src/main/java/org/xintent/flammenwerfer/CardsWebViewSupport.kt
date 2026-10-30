package org.xintent.flammenwerfer

import android.annotation.SuppressLint
import android.content.*
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.provider.OpenableColumns
import android.speech.tts.TextToSpeech
import android.util.*
import android.webkit.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.core.XIntentLogManager

object CardsWebViewSupport {

    fun loadXIntentJs(context: Context): String {
        return try {
            context.assets.open("xintent_bridge.js").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            Log.e("CardsWebViewSupport", "Failed to load xintent_bridge.js asset", e)
            ""
        }
    }

    fun extractPickFileAcceptMime(jsonPayload: String?): String {
        return try {
            jsonPayload?.takeIf { it.isNotBlank() }?.let { JSONObject(it).optString("Accept", "") }
                ?.takeIf { it.isNotBlank() && it != "*/*" } ?: "*/*"
        } catch (_: Exception) {
            "*/*"
        }
    }

    fun writeSavedDocumentUri(context: Context, uri: Uri, bytes: ByteArray): String {
        return try {
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            JSONObject().put("status", "ok").put("message", "Saved to local Android storage").toString()
        } catch (e: Exception) {
            JSONObject().put("status", "error").put("message", e.message ?: "Failed to save file").toString()
        }
    }

    fun evaluateXAudioFrame(webView: WebView?, responseJson: JSONObject) {
        val jsonStr = responseJson.toString()
        val jsCode = """
            (function() {
                var frame = $jsonStr;
                if (window.xaudio && window.xaudio._wsListeners) {
                    for (var i = 0; i < window.xaudio._wsListeners.length; i++) {
                        try { window.xaudio._wsListeners[i](frame); } catch(_) {}
                    }
                }
            })();
        """.trimIndent()
        webView?.evaluateJavascript(jsCode, null)
    }

    private fun buildTtsResponseJson(status: String, message: String, disposition: String, txId: Int): String =
        JSONObject().apply {
            put("event", "ui.TextToSpeechResponse")
            put("intent", "ui.TextToSpeechResponse")
            put("status", status)
            put("message", message)
            put("disposition", disposition)
            put("controlWord", 2)
            if (txId != 0) put("txId", txId)
        }.toString()

    private fun resolveTtsSpeed(json: JSONObject): Float = when {
        json.has("speed") -> json.optDouble("speed", 1.0).toFloat()
        json.has("rate") -> json.optDouble("rate", 1.0).toFloat()
        else -> json.optDouble("speechRate", 1.0).toFloat()
    }

    fun handleLocalTts(ttsEngine: TextToSpeech?, jsonPayload: String): String {
        return try {
            val json = JSONObject(jsonPayload)
            val textToSpeak = json.optString("text", "").ifBlank { json.optString("data", "") }
            val txId = json.optInt("txId", 0)
            if (textToSpeak.isBlank()) {
                return buildTtsResponseJson("error", "No text provided for speech synthesis", "error", txId)
            }
            ttsEngine?.setSpeechRate(resolveTtsSpeed(json))
            ttsEngine?.speak(textToSpeak, TextToSpeech.QUEUE_ADD, null, "xintent_local_tts_${System.currentTimeMillis()}")
            XIntentLogManager.addLog("[ui.TextToSpeech] Local Android Speech Engine speaking: \"${textToSpeak.take(50)}\"")
            buildTtsResponseJson("ok", "Speaking via local Android TTS", "final", txId)
        } catch (e: Exception) {
            buildTtsResponseJson("error", e.message ?: "Failed to trigger local TTS", "error", 0)
        }
    }

    fun handleLocalCopy(context: Context, jsonPayload: String): String {
        return try {
            val json = JSONObject(jsonPayload)
            val textToCopy = json.optString("text", "")
                .ifBlank { json.optString("data", "") }
                .ifBlank { json.optJSONObject("blob")?.optString("data", "") ?: "" }
            if (textToCopy.isBlank()) {
                return JSONObject().put("status", "error").put("message", "No text provided to copy").toString()
            }
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("XIntent Copy", textToCopy))
            XIntentLogManager.addLog("[ui.Copy] Copied to Android system clipboard (${textToCopy.length} chars)")
            JSONObject().put("status", "ok")
                .put("message", "Copied to Android system clipboard")
                .put("disposition", "final").toString()
        } catch (e: Exception) {
            JSONObject().put("status", "error").put("message", e.message ?: "Failed to copy").toString()
        }
    }

    fun handleLocalPaste(context: Context): String {
        return try {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val pastedText = clipboard.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
            XIntentLogManager.addLog("[ui.Paste] Pasted from Android system clipboard (${pastedText.length} chars)")
            val blobObj = JSONObject().apply {
                put("name", "clipboard.txt")
                put("type", "text/plain")
                put("size", pastedText.toByteArray(Charsets.UTF_8).size)
                put("_dataType", "text")
                put("data", pastedText)
            }
            JSONObject().apply {
                put("event", "ui.PasteResponse")
                put("status", "ok")
                put("text", pastedText)
                put("blob", blobObj)
                put("disposition", "final")
            }.toString()
        } catch (e: Exception) {
            JSONObject().put("status", "error").put("message", e.message ?: "Failed to paste").toString()
        }
    }

    fun buildPickedFileResponse(context: Context, uri: Uri): String {
        val resolver = context.contentResolver
        val mimeType = resolver.getType(uri) ?: "*/*"
        val fileName = queryDisplayName(context, uri) ?: "picked_file"
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: ByteArray(0)
        val isText = mimeType.startsWith("text/")
        val blobObj = JSONObject().apply {
            put("name", fileName)
            put("type", mimeType)
            put("size", bytes.size)
            put("_dataType", if (isText) "text" else "base64")
            put("data", if (isText) String(bytes, Charsets.UTF_8) else Base64.encodeToString(bytes, Base64.NO_WRAP))
        }
        return JSONObject().apply {
            put("event", "fs.PickFileResponse")
            put("status", "ok")
            put("blob", blobObj)
            put("disposition", "final")
        }.toString()
    }

    private fun queryDisplayName(context: Context, uri: Uri): String? {
        return try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx != -1) cursor.getString(idx)?.takeIf { it.isNotBlank() } else null
                } else null
            }
        } catch (_: Exception) {
            null
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun createConfiguredWebView(context: Context, activity: CardsActivity?, jsBridgeScript: String, cardUrl: String): WebView {
        return WebView(context).apply {
            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    view?.evaluateJavascript(jsBridgeScript, null)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    view?.evaluateJavascript(jsBridgeScript, null)
                }

                @SuppressLint("WebViewClientOnReceivedSslError")
                override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                    handler?.proceed()
                }
            }
            webChromeClient = WebChromeClient()
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = true
                useWideViewPort = true
                loadWithOverviewMode = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            }
            activity?.cardWebView = this
            addJavascriptInterface(XIntentJSBridge(activity ?: CardsActivity()), "XIntentNative")
            loadUrl(cardUrl)
        }
    }
}

@Composable
fun CardScreen(
    appName: String,
    cardName: String,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val activity = context as? CardsActivity
    val cardUrl = remember { "${XIntentPreferences.getServerUrl(context)}/apps/$appName/$cardName" }
    val jsBridgeScript = remember(context) { CardsWebViewSupport.loadXIntentJs(context) }
    var webViewRef: WebView? = remember { null }

    Column(modifier = modifier.fillMaxSize()) {
        CardTopToolbar(
            isPinned = activity?.isPinned == true,
            onClose = onClose,
            onOpenSettings = {
                val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                context.startActivity(intent)
            },
            onTogglePin = { activity?.togglePinCard(!(activity.isPinned)) },
            onMigrate = { activity?.triggerLiveMigrate() },
            onReload = { webViewRef?.reload() },
        )

        Text(
            text = "$appName / $cardName",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
        )

        AndroidView(
            factory = { ctx ->
                CardsWebViewSupport.createConfiguredWebView(ctx, activity, jsBridgeScript, cardUrl).also {
                    webViewRef = it
                }
            },
            onRelease = { webView ->
                webView.stopLoading()
                webView.removeAllViews()
                webView.destroy()
            },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
private fun CardTopToolbar(
    isPinned: Boolean,
    onClose: () -> Unit,
    onOpenSettings: () -> Unit,
    onTogglePin: () -> Unit,
    onMigrate: () -> Unit = {},
    onReload: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedButton(onClick = onClose) { Text("Close") }
        OutlinedButton(onClick = onOpenSettings) { Text("Settings") }
        val containerColor = if (isPinned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant
        val contentColor = if (isPinned) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
        Button(
            onClick = onTogglePin,
            colors = ButtonDefaults.buttonColors(containerColor = containerColor, contentColor = contentColor),
        ) {
            Text(if (isPinned) "📌 Pinned" else "📌 Pin")
        }
        OutlinedButton(onClick = onMigrate) { Text("Migrate ↗") }
        Spacer(modifier = Modifier.weight(1f))
        Button(onClick = onReload) { Text("Reload") }
    }
}
