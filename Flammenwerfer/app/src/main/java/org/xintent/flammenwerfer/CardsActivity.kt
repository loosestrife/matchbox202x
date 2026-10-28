package org.xintent.flammenwerfer

import android.Manifest
import android.content.*
import android.content.pm.PackageManager
import android.os.*
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.util.*
import android.webkit.WebView
import androidx.activity.*
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import org.json.JSONObject
import org.xintent.flammenwerfer.audio.LocalAudioPlayer
import org.xintent.flammenwerfer.core.XIntentLogManager
import org.xintent.flammenwerfer.ui.theme.FlammenwerferTheme
import java.util.Locale
import java.util.concurrent.CountDownLatch

class CardsActivity : ComponentActivity() {

    companion object {
        var instance: CardsActivity? = null
        const val EXTRA_APP_NAME = "extra_app_name"
        const val EXTRA_CARD_NAME = "extra_card_name"

        fun loadXIntentJs(context: Context): String = CardsWebViewSupport.loadXIntentJs(context)
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
        val uri = result.data?.data
        val resStr = if (result.resultCode == RESULT_OK && uri != null) {
            CardsWebViewSupport.buildPickedFileResponse(this, uri)
        } else {
            JSONObject().put("status", "error").put("message", "Cancelled by user").toString()
        }
        pendingPickCallback?.invoke(resStr)
        pendingPickCallback = null
    }

    private val localSaveLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uri = result.data?.data
        val resStr = if (result.resultCode == RESULT_OK && uri != null) {
            CardsWebViewSupport.writeSavedDocumentUri(this, uri, pendingSaveBytes ?: ByteArray(0))
        } else {
            JSONObject().put("status", "error").put("message", "Cancelled by user").toString()
        }
        pendingSaveCallback?.invoke(resStr)
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
        if (pinned) checkAndRequestNotificationPermission()
        runOnUiThread {
            val serviceIntent = buildPinServiceIntent(pinned)
            if (pinned && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
            if (pinned) {
                cardWebView?.onResume()
                cardWebView?.resumeTimers()
                XIntentLogManager.addLog("[CardsActivity 📌] Card Pinned (Foreground Service & CPU WakeLock active - screen can turn off in pocket)")
            } else {
                XIntentLogManager.addLog("[CardsActivity 📌] Card Unpinned")
            }
        }
    }

    private fun buildPinServiceIntent(pinned: Boolean): Intent =
        Intent(this, XIntentCardService::class.java).apply {
            action = if (pinned) XIntentCardService.ACTION_START_PINNED else XIntentCardService.ACTION_STOP_PINNED
            if (pinned) {
                putExtra("appName", intent.getStringExtra(EXTRA_APP_NAME) ?: "Web Card")
                putExtra("cardName", intent.getStringExtra(EXTRA_CARD_NAME) ?: "index")
            }
        }

    private fun checkAndRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
        }
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (e: Exception) {
                Log.e("CardsActivity", "Error requesting battery optimization exemption", e)
            }
        }
    }

    fun dispatchJsXAudioResponse(responseJson: JSONObject) {
        runOnUiThread { CardsWebViewSupport.evaluateXAudioFrame(cardWebView, responseJson) }
    }

    fun triggerLocalPrefetch(jsonPayload: String): String =
        localAudioPlayer?.triggerLocalPrefetch(jsonPayload) ?: "{}"

    fun triggerLocalAudioPlay(jsonPayload: String): String =
        localAudioPlayer?.triggerLocalAudioPlay(jsonPayload) ?: "{}"

    fun triggerLocalAudioControl(jsonPayload: String): String =
        localAudioPlayer?.triggerLocalAudioControl(jsonPayload) ?: "{}"

    fun triggerLocalTts(jsonPayload: String): String =
        CardsWebViewSupport.handleLocalTts(localTtsEngine, jsonPayload)

    fun triggerLocalCopy(jsonPayload: String): String =
        CardsWebViewSupport.handleLocalCopy(this, jsonPayload)

    fun triggerLocalPaste(): String =
        CardsWebViewSupport.handleLocalPaste(this)

    fun triggerLocalPickFile(jsonPayload: String? = null): String {
        val acceptMime = CardsWebViewSupport.extractPickFileAcceptMime(jsonPayload)
        var responseString = ""
        val latch = CountDownLatch(1)
        runOnUiThread {
            try {
                val docIntent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    if (acceptMime != "*/*") {
                        putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(acceptMime, "application/octet-stream", "application/zip", "*/*"))
                    }
                }
                pendingPickCallback = { res ->
                    responseString = res
                    latch.countDown()
                }
                localPickLauncher.launch(docIntent)
            } catch (_: Exception) {
                latch.countDown()
            }
        }
        latch.await()
        return responseString.ifBlank { "{\"status\":\"ok\"}" }
    }

    fun triggerLocalSendTo(jsonPayload: String): String {
        return try {
            val blobObj = JSONObject(jsonPayload).optJSONObject("blob") ?: JSONObject()
            val fileName = blobObj.optString("name", "saved_file.txt")
            val mimeType = blobObj.optString("type", "*/*")
            val rawData = blobObj.optString("data", "")
            pendingSaveBytes = if (blobObj.optString("_dataType", "text") == "base64") {
                Base64.decode(rawData, Base64.DEFAULT)
            } else {
                rawData.toByteArray(Charsets.UTF_8)
            }

            val createIntent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = mimeType
                putExtra(Intent.EXTRA_TITLE, fileName)
            }
            var responseString = ""
            val latch = CountDownLatch(1)
            runOnUiThread {
                try {
                    pendingSaveCallback = { res ->
                        responseString = res
                        latch.countDown()
                    }
                    localSaveLauncher.launch(createIntent)
                } catch (_: Exception) {
                    latch.countDown()
                }
            }
            latch.await()
            responseString.ifBlank { "{\"status\":\"ok\"}" }
        } catch (e: Exception) {
            JSONObject().put("status", "error").put("message", e.message ?: "Invalid SaveAs payload").toString()
        }
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
        if (!isPinned) cardWebView?.onPause()
    }

    override fun onStop() {
        super.onStop()
        if (!isPinned) cardWebView?.pauseTimers()
    }

    override fun onDestroy() {
        localTtsEngine?.stop()
        localTtsEngine?.shutdown()
        localTtsEngine = null
        localAudioPlayer?.release()
        localAudioPlayer = null
        cardWebView = null
        if (instance == this) instance = null
        super.onDestroy()
    }
}
