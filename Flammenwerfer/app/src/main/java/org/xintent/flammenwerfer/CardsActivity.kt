package org.xintent.flammenwerfer

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.OpenableColumns
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.util.Log
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject
import org.xintent.flammenwerfer.audio.LocalAudioPlayer
import org.xintent.flammenwerfer.ui.theme.FlammenwerferTheme
import java.util.Locale
import java.util.concurrent.CountDownLatch

class CardsActivity : ComponentActivity() {

    companion object {
        var instance: CardsActivity? = null
        const val EXTRA_APP_NAME = "extra_app_name"
        const val EXTRA_CARD_NAME = "extra_card_name"

        fun loadXIntentJs(context: Context): String {
            return try {
                context.assets.open("xintent_bridge.js").bufferedReader().use { it.readText() }
            } catch (e: Exception) {
                Log.e("CardsActivity", "Failed to load xintent_bridge.js asset", e)
                ""
            }
        }
    }

    private var localTtsEngine: TextToSpeech? = null
    private var localAudioPlayer: LocalAudioPlayer? = null
    private var pendingPickCallback: ((String) -> Unit)? = null
    private var pendingSaveBytes: ByteArray? = null
    private var pendingSaveCallback: ((String) -> Unit)? = null

    var cardWebView: WebView? = null

    var isPinned by mutableStateOf(false)
        private set

    private val localPickLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK && result.data?.data != null) {
            val uri = result.data!!.data!!
            val mimeType = contentResolver.getType(uri) ?: "*/*"
            var fileName = "picked_file"
            try {
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (nameIdx != -1) {
                            val name = cursor.getString(nameIdx)
                            if (!name.isNullOrBlank()) fileName = name
                        }
                    }
                }
            } catch (_: Exception) {
            }

            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: ByteArray(0)
            val isText = mimeType.startsWith("text/")
            val base64Data = Base64.encodeToString(bytes, Base64.NO_WRAP)

            val blobObj = JSONObject().apply {
                put("name", fileName)
                put("type", mimeType)
                put("size", bytes.size)
                put("_dataType", if (isText) "text" else "base64")
                put("data", if (isText) String(bytes, Charsets.UTF_8) else base64Data)
            }

            val resObj = JSONObject().apply {
                put("event", "fs.PickFileResponse")
                put("status", "ok")
                put("blob", blobObj)
                put("disposition", "final")
            }

            pendingPickCallback?.invoke(resObj.toString())
        } else {
            val errObj = JSONObject().apply {
                put("status", "error")
                put("message", "Cancelled by user")
            }
            pendingPickCallback?.invoke(errObj.toString())
        }
        pendingPickCallback = null
    }

    private val localSaveLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK && result.data?.data != null) {
            val uri = result.data!!.data!!
            val bytes = pendingSaveBytes ?: ByteArray(0)
            try {
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                val okObj = JSONObject().apply {
                    put("status", "ok")
                    put("message", "Saved to local Android storage")
                }
                pendingSaveCallback?.invoke(okObj.toString())
            } catch (e: Exception) {
                val errObj = JSONObject().apply {
                    put("status", "error")
                    put("message", e.message ?: "Failed to save file")
                }
                pendingSaveCallback?.invoke(errObj.toString())
            }
        } else {
            val errObj = JSONObject().apply {
                put("status", "error")
                put("message", "Cancelled by user")
            }
            pendingSaveCallback?.invoke(errObj.toString())
        }
        pendingSaveBytes = null
        pendingSaveCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this
        enableEdgeToEdge()

        localTtsEngine = TextToSpeech(applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                localTtsEngine?.language = Locale.US
            }
        }

        localAudioPlayer = LocalAudioPlayer(applicationContext) { responseJson ->
            dispatchJsXAudioResponse(responseJson)
        }

        val appName = intent.getStringExtra(EXTRA_APP_NAME) ?: "intent-test-card"
        val cardName = intent.getStringExtra(EXTRA_CARD_NAME) ?: "index"

        setContent {
            FlammenwerferTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    CardScreen(
                        appName = appName,
                        cardName = cardName,
                        onClose = { finish() },
                        modifier = Modifier.padding(innerPadding),
                    )
                }
            }
        }
    }

    fun togglePinCard(pinned: Boolean) {
        isPinned = pinned
        if (pinned) {
            checkAndRequestNotificationPermission()
        }
        runOnUiThread {
            val serviceIntent = Intent(this, XIntentCardService::class.java).apply {
                if (pinned) {
                    action = XIntentCardService.ACTION_START_PINNED
                    putExtra("appName", intent.getStringExtra(EXTRA_APP_NAME) ?: "Web Card")
                    putExtra("cardName", intent.getStringExtra(EXTRA_CARD_NAME) ?: "index")
                } else {
                    action = XIntentCardService.ACTION_STOP_PINNED
                }
            }

            if (pinned) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(serviceIntent)
                } else {
                    startService(serviceIntent)
                }
                cardWebView?.onResume()
                cardWebView?.resumeTimers()
                XIntentClient.addLog("[CardsActivity 📌] Card Pinned (Foreground Service & CPU WakeLock active - screen can turn off in pocket)")
            } else {
                startService(serviceIntent)
                XIntentClient.addLog("[CardsActivity 📌] Card Unpinned")
            }
        }
    }

    private fun checkAndRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val powerManager = getSystemService(POWER_SERVICE) as PowerManager
            if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
                try {
                    val intent = Intent(
                        Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
                    )
                    startActivity(intent)
                } catch (e: Exception) {
                    Log.e("CardsActivity", "Error requesting battery optimization exemption", e)
                }
            }
        }
    }

    fun dispatchJsXAudioResponse(responseJson: JSONObject) {
        runOnUiThread {
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
            cardWebView?.evaluateJavascript(jsCode, null)
        }
    }

    fun triggerLocalPrefetch(jsonPayload: String): String {
        return localAudioPlayer?.triggerLocalPrefetch(jsonPayload) ?: "{}"
    }

    fun triggerLocalAudioPlay(jsonPayload: String): String {
        return localAudioPlayer?.triggerLocalAudioPlay(jsonPayload) ?: "{}"
    }

    fun triggerLocalAudioControl(jsonPayload: String): String {
        return localAudioPlayer?.triggerLocalAudioControl(jsonPayload) ?: "{}"
    }

    fun triggerLocalTts(jsonPayload: String): String {
        return try {
            val json = JSONObject(jsonPayload)
            val textToSpeak = json.optString("text", "")
                .ifBlank { json.optString("data", "") }
            val txId = json.optInt("txId", 0)

            if (textToSpeak.isNotBlank()) {
                val speed = if (json.has("speed")) {
                    json.optDouble("speed", 1.0).toFloat()
                } else if (json.has("rate")) {
                    json.optDouble("rate", 1.0).toFloat()
                } else {
                    json.optDouble("speechRate", 1.0).toFloat()
                }
                localTtsEngine?.setSpeechRate(speed)
                localTtsEngine?.speak(textToSpeak, TextToSpeech.QUEUE_ADD, null, "xintent_local_tts_${System.currentTimeMillis()}")
                XIntentClient.addLog("[ui.TextToSpeech] Local Android Speech Engine speaking: \"${textToSpeak.take(50)}\"")

                JSONObject().apply {
                    put("event", "ui.TextToSpeechResponse")
                    put("intent", "ui.TextToSpeechResponse")
                    put("status", "ok")
                    put("message", "Speaking via local Android TTS")
                    put("disposition", "final")
                    put("controlWord", 2)
                    if (txId != 0) put("txId", txId)
                }.toString()
            } else {
                JSONObject().apply {
                    put("event", "ui.TextToSpeechResponse")
                    put("intent", "ui.TextToSpeechResponse")
                    put("status", "error")
                    put("message", "No text provided for speech synthesis")
                    put("disposition", "error")
                    put("controlWord", 2)
                    if (txId != 0) put("txId", txId)
                }.toString()
            }
        } catch (e: Exception) {
            JSONObject().apply {
                put("event", "ui.TextToSpeechResponse")
                put("intent", "ui.TextToSpeechResponse")
                put("status", "error")
                put("message", e.message ?: "Failed to trigger local TTS")
                put("disposition", "error")
                put("controlWord", 2)
            }.toString()
        }
    }

    fun triggerLocalCopy(jsonPayload: String): String {
        return try {
            val json = JSONObject(jsonPayload)
            val textToCopy = json.optString("text", "")
                .ifBlank { json.optString("data", "") }
                .ifBlank { json.optJSONObject("blob")?.optString("data", "") ?: "" }

            if (textToCopy.isNotBlank()) {
                val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                val clip = ClipData.newPlainText("XIntent Copy", textToCopy)
                clipboard.setPrimaryClip(clip)
                XIntentClient.addLog("[ui.Copy] Copied to Android system clipboard (${textToCopy.length} chars)")

                JSONObject().apply {
                    put("status", "ok")
                    put("message", "Copied to Android system clipboard")
                    put("disposition", "final")
                }.toString()
            } else {
                JSONObject().apply {
                    put("status", "error")
                    put("message", "No text provided to copy")
                }.toString()
            }
        } catch (e: Exception) {
            JSONObject().apply {
                put("status", "error")
                put("message", e.message ?: "Failed to copy")
            }.toString()
        }
    }

    fun triggerLocalPaste(): String {
        return try {
            val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            val clip = clipboard.primaryClip
            val pastedText = clip?.getItemAt(0)?.text?.toString() ?: ""

            XIntentClient.addLog("[ui.Paste] Pasted from Android system clipboard (${pastedText.length} chars)")

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
            JSONObject().apply {
                put("status", "error")
                put("message", e.message ?: "Failed to paste")
            }.toString()
        }
    }

    fun triggerLocalPickFile(jsonPayload: String? = null): String {
        var responseString = ""
        val latch = CountDownLatch(1)

        var acceptMime = "*/*"
        try {
            if (!jsonPayload.isNullOrBlank()) {
                val json = JSONObject(jsonPayload)
                val accept = json.optString("Accept", "")
                if (accept.isNotBlank() && accept != "*/*") {
                    acceptMime = accept
                }
            }
        } catch (_: Exception) {}

        runOnUiThread {
            try {
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    if (acceptMime.isNotBlank() && acceptMime != "*/*") {
                        putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(acceptMime, "application/octet-stream", "application/zip", "*/*"))
                    }
                }
                pendingPickCallback = { res ->
                    responseString = res
                    latch.countDown()
                }
                localPickLauncher.launch(intent)
            } catch (e: Exception) {
                latch.countDown()
            }
        }

        latch.await()
        return responseString.ifBlank { "{\"status\":\"ok\"}" }
    }

    fun triggerLocalSendTo(jsonPayload: String): String {
        var responseString = ""
        try {
            val json = JSONObject(jsonPayload)
            val blobObj = json.optJSONObject("blob") ?: JSONObject()
            val fileName = blobObj.optString("name", "saved_file.txt")
            val mimeType = blobObj.optString("type", "*/*")
            val dataType = blobObj.optString("_dataType", "text")
            val rawData = blobObj.optString("data", "")

            val bytes = if (dataType == "base64") {
                Base64.decode(rawData, Base64.DEFAULT)
            } else {
                rawData.toByteArray(Charsets.UTF_8)
            }

            pendingSaveBytes = bytes

            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = mimeType
                putExtra(Intent.EXTRA_TITLE, fileName)
            }

            val latch = CountDownLatch(1)
            runOnUiThread {
                try {
                    pendingSaveCallback = { res ->
                        responseString = res
                        latch.countDown()
                    }
                    localSaveLauncher.launch(intent)
                } catch (e: Exception) {
                    latch.countDown()
                }
            }
            latch.await()
        } catch (e: Exception) {
            val errObj = JSONObject().apply {
                put("status", "error")
                put("message", e.message ?: "Invalid SaveAs payload")
            }
            responseString = errObj.toString()
        }
        return responseString.ifBlank { "{\"status\":\"ok\"}" }
    }

    override fun onResume() {
        super.onResume()
        cardWebView?.onResume()
        cardWebView?.resumeTimers()
    }

    override fun onStart() {
        super.onStart()
        cardWebView?.onResume()
        cardWebView?.resumeTimers()
    }

    override fun onPause() {
        super.onPause()
        if (!isPinned) {
            cardWebView?.onPause()
        }
    }

    override fun onStop() {
        super.onStop()
        if (!isPinned) {
            cardWebView?.pauseTimers()
        }
    }

    override fun onDestroy() {
        localTtsEngine?.stop()
        localTtsEngine?.shutdown()
        localTtsEngine = null

        localAudioPlayer?.release()
        localAudioPlayer = null

        cardWebView = null

        if (instance == this) {
            instance = null
        }
        super.onDestroy()
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun CardScreen(
    appName: String,
    cardName: String,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val activity = context as? CardsActivity
    val baseUrl = remember { XIntentClient.getServerUrl(context) }
    val cardUrl = remember { "$baseUrl/apps/$appName/$cardName" }
    val jsBridgeScript = remember(context) { CardsActivity.loadXIntentJs(context) }

    var webViewRef: WebView? = remember { null }

    Column(modifier = modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedButton(onClick = onClose) {
                Text("Close")
            }

            OutlinedButton(
                onClick = {
                    val intent = Intent(context, MainActivity::class.java).apply {
                        addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    }
                    context.startActivity(intent)
                },
            ) {
                Text("Settings")
            }

            val isPinned = activity?.isPinned == true
            Button(
                onClick = {
                    activity?.togglePinCard(!isPinned)
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isPinned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = if (isPinned) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
                ),
            ) {
                Text(if (isPinned) "📌 Pinned" else "📌 Pin")
            }

            Spacer(modifier = Modifier.weight(1f))

            Button(onClick = { webViewRef?.reload() }) {
                Text("Reload")
            }
        }

        Text(
            text = "$appName / $cardName",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
        )

        AndroidView(
            factory = { ctx ->
                WebView(ctx).apply {
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
                    webViewRef = this
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
