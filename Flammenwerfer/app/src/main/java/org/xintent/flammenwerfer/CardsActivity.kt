package org.xintent.flammenwerfer

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaPlayer
import android.os.Bundle
import android.provider.OpenableColumns
import android.speech.tts.TextToSpeech
import android.util.Base64
import java.io.File
import java.io.FileOutputStream
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.xintent.flammenwerfer.ui.theme.FlammenwerferTheme
import java.util.Locale

class CardsActivity : ComponentActivity() {

    companion object {
        const val EXTRA_APP_NAME = "extra_app_name"
        const val EXTRA_CARD_NAME = "extra_card_name"

        const val INJECT_XINTENT_JS = """
(function() {
  if (window.xintent && typeof window.xintent.intent === 'function') return;

  window.xintent = {
    getTags: async function() {
      if (window.XIntentNative && typeof window.XIntentNative.fetchApiTagsJson === 'function') {
        try {
          var raw = window.XIntentNative.fetchApiTagsJson();
          if (raw) return JSON.parse(raw);
        } catch(e) {}
      }
      var res = await fetch('/api/tags');
      return await res.json();
    },

    intent: async function(intentName, payload, targetApp) {
      if (window.XIntentNative && typeof window.XIntentNative.isLocalAudioEnabled === 'function' && window.XIntentNative.isLocalAudioEnabled()) {
        if (intentName === 'xaudio.PlaySoundBlob' || intentName === 'xaudio.PlayStream') {
          var rawRes = window.XIntentNative.handleLocalAudioPlay(JSON.stringify(payload || {}));
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (intentName === 'xaudio.ControlStream') {
          var rawRes = window.XIntentNative.handleLocalAudioControl(JSON.stringify(payload || {}));
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (window.XIntentNative && typeof window.XIntentNative.isLocalTtsEnabled === 'function' && window.XIntentNative.isLocalTtsEnabled()) {
        if (intentName === 'ui.TextToSpeech') {
          var rawRes = window.XIntentNative.handleLocalTts(JSON.stringify(payload || {}));
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (window.XIntentNative && typeof window.XIntentNative.isLocalClipboardEnabled === 'function' && window.XIntentNative.isLocalClipboardEnabled()) {
        if (intentName === 'ui.Copy') {
          var rawRes = window.XIntentNative.handleLocalCopy(JSON.stringify(payload || {}));
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (intentName === 'ui.Paste') {
          var rawRes = window.XIntentNative.handleLocalPaste();
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (window.XIntentNative && typeof window.XIntentNative.isLocalFsEnabled === 'function' && window.XIntentNative.isLocalFsEnabled()) {
        if (intentName === 'fs.PickFile') {
          var rawRes = window.XIntentNative.handleLocalPickFile();
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (intentName === 'fs.SaveAs') {
          var rawRes = window.XIntentNative.handleLocalSaveAs(JSON.stringify(payload || {}));
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }

      var parts = (intentName || '').split('.');
      var namespace = parts[0] || 'ui';
      var action = parts[1] || intentName;
      var app = targetApp || (payload && payload.app) || 'localhost';

      var url = '/intent/' + namespace + '/' + action + '?app=' + encodeURIComponent(app);

      var bodyData = Object.assign({}, payload || {}, {
        intent: intentName,
        app: app
      });

      var headers = {
        'Content-Type': 'application/json',
        'Accept': (payload && payload.Accept) ? payload.Accept : '*/*'
      };
      if (payload && payload.controlWord !== undefined) {
        var ctrlStrings = [];
        if (payload.controlWord & 1) ctrlStrings.push('SYN');
        if (payload.controlWord & 2) ctrlStrings.push('FIN');
        if (ctrlStrings.length > 0) {
          headers['X-Channel-Control'] = ctrlStrings.join(',');
        }
      }

      var response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(bodyData)
      });
      response.parseMultipart = async function() {
        var text = await this.text();
        return window.xintent.parseMultipartResponse(text);
      };
      return response;
    },

    parseMultipartResponse: function(responseText) {
      var parts = [];
      if (!responseText || typeof responseText !== 'string') return parts;

      if (!responseText.includes('MatchboxFrameBoundary')) {
        try {
          parts.push({ headers: {}, json: JSON.parse(responseText) });
        } catch (_) {
          parts.push({ headers: {}, body: responseText });
        }
        return parts;
      }

      var lines = responseText.split(/\r?\n/);
      var boundary = lines[0].trim();
      var rawParts = responseText.split(boundary).filter(function(p) {
        return p.trim() && !p.includes('--\r') && !p.includes('--\n');
      });

      for (var i = 0; i < rawParts.length; i++) {
        var part = rawParts[i];
        var headerEnd = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
        if (headerEnd === -1) continue;

        var headerText = part.slice(0, headerEnd);
        var bodyText = part.slice(headerEnd).trim();

        var headers = {};
        headerText.split(/\r?\n/).forEach(function(line) {
          var colon = line.indexOf(':');
          if (colon !== -1) {
            var k = line.slice(0, colon).trim().toLowerCase();
            var v = line.slice(colon + 1).trim();
            headers[k] = v;
          }
        });

        try {
          var json = JSON.parse(bodyText);
          parts.push({ headers: headers, json: json, body: bodyText });
        } catch (_) {
          parts.push({ headers: headers, body: bodyText });
        }
      }
      return parts;
    }
  };

  console.log('[Flammenwerfer] Attached window.xintent runtime library.');
})();
"""
    }

    private var localTtsEngine: TextToSpeech? = null
    private var pendingPickCallback: ((String) -> Unit)? = null
    private var pendingSaveBytes: ByteArray? = null
    private var pendingSaveCallback: ((String) -> Unit)? = null

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

    fun triggerLocalTts(jsonPayload: String): String {
        return try {
            val json = JSONObject(jsonPayload)
            val textToSpeak = json.optString("text", "")
                .ifBlank { json.optString("data", "") }

            if (textToSpeak.isNotBlank()) {
                val speed = json.optDouble("speed", 1.0).toFloat()
                localTtsEngine?.setSpeechRate(speed)
                localTtsEngine?.speak(textToSpeak, TextToSpeech.QUEUE_ADD, null, "xintent_local_tts_${System.currentTimeMillis()}")
                XIntentClient.addLog("[ui.TextToSpeech] Local Android Speech Engine speaking: \"${textToSpeak.take(50)}\"")

                JSONObject().apply {
                    put("status", "ok")
                    put("message", "Speaking via local Android TTS")
                    put("disposition", "final")
                }.toString()
            } else {
                JSONObject().apply {
                    put("status", "error")
                    put("message", "No text provided for speech synthesis")
                }.toString()
            }
        } catch (e: Exception) {
            JSONObject().apply {
                put("status", "error")
                put("message", e.message ?: "Failed to trigger local TTS")
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

    fun triggerLocalPickFile(): String {
        var responseString = ""
        runBlocking {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
            }
            pendingPickCallback = { res -> responseString = res }
            localPickLauncher.launch(intent)
        }
        return responseString.ifBlank { "{\"status\":\"ok\"}" }
    }

    fun triggerLocalSaveAs(jsonPayload: String): String {
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
            pendingSaveCallback = { res -> responseString = res }
            localSaveLauncher.launch(intent)
        } catch (e: Exception) {
            val errObj = JSONObject().apply {
                put("status", "error")
                put("message", e.message ?: "Invalid SaveAs payload")
            }
            responseString = errObj.toString()
        }
        return responseString.ifBlank { "{\"status\":\"ok\"}" }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        localTtsEngine = TextToSpeech(applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                localTtsEngine?.language = Locale.US
            }
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

    private var localMediaPlayer: MediaPlayer? = null

    fun triggerLocalAudioPlay(jsonPayload: String): String {
        return try {
            val json = JSONObject(jsonPayload)
            val cookie = json.optString("cookie")
                .ifBlank { json.optString("Cookie", "default") }
            val seqnum = json.optInt("seqnum", json.optInt("seq", 0))
            val streamId = json.optInt("streamId", json.optInt("stream", 1))

            var audioBytes: ByteArray? = null
            if (json.has("data") && json.optString("_dataType") == "base64") {
                audioBytes = Base64.decode(json.getString("data"), Base64.DEFAULT)
            } else if (json.has("blob")) {
                val blobObj = json.optJSONObject("blob")
                if (blobObj != null && blobObj.optString("_dataType") == "base64") {
                    audioBytes = Base64.decode(blobObj.getString("data"), Base64.DEFAULT)
                }
            }

            if (audioBytes != null && audioBytes.isNotEmpty()) {
                val tempAudioFile = File.createTempFile("flammen_audio_", ".wav", cacheDir)
                FileOutputStream(tempAudioFile).use { fos ->
                    fos.write(audioBytes)
                }

                localMediaPlayer?.release()
                localMediaPlayer = MediaPlayer().apply {
                    setDataSource(tempAudioFile.absolutePath)
                    prepare()
                    start()
                }

                XIntentClient.addLog("[xaudio.PlaySoundBlob] Playing audio on phone speaker (${audioBytes.size} bytes, seq #$seqnum)")

                JSONObject().apply {
                    put("event", "XAudioPlayResponseV0")
                    put("status", 200)
                    put("cookie", cookie)
                    put("OutputId", cookie)
                    put("streamId", streamId)
                    put("seqnum", seqnum)
                }.toString()
            } else {
                JSONObject().apply {
                    put("status", "ok")
                    put("message", "XAudioPlay queued")
                    put("cookie", cookie)
                    put("seqnum", seqnum)
                }.toString()
            }
        } catch (e: Exception) {
            JSONObject().apply {
                put("status", "error")
                put("message", e.message ?: "Failed local audio playback")
            }.toString()
        }
    }

    fun triggerLocalAudioControl(jsonPayload: String): String {
        return try {
            val json = JSONObject(jsonPayload)
            val command = json.optString("command", "stop")
            if (command == "stop" || command == "pause") {
                localMediaPlayer?.stop()
                localMediaPlayer?.release()
                localMediaPlayer = null
                XIntentClient.addLog("[xaudio.ControlStream] Stopped phone speaker audio playback")
            }
            JSONObject().apply {
                put("status", "ok")
                put("command", command)
            }.toString()
        } catch (e: Exception) {
            JSONObject().apply {
                put("status", "error")
                put("message", e.message ?: "Failed audio control")
            }.toString()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        localMediaPlayer?.stop()
        localMediaPlayer?.release()
        localMediaPlayer = null
        localTtsEngine?.stop()
        localTtsEngine?.shutdown()
        localTtsEngine = null
    }
}

class XIntentJSBridge(private val activity: CardsActivity) {
    @Suppress("unused")
    @JavascriptInterface
    fun isLocalAudioEnabled(): Boolean {
        return XIntentClient.isLocalAudioEnabled(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalAudioPlay(jsonPayload: String): String {
        return activity.triggerLocalAudioPlay(jsonPayload)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalAudioControl(jsonPayload: String): String {
        return activity.triggerLocalAudioControl(jsonPayload)
    }
    @Suppress("unused")
    @JavascriptInterface
    fun isLocalTtsEnabled(): Boolean {
        return XIntentClient.isLocalTtsEnabled(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalTts(jsonPayload: String): String {
        return activity.triggerLocalTts(jsonPayload)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun isLocalClipboardEnabled(): Boolean {
        return XIntentClient.isLocalClipboardEnabled(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalCopy(jsonPayload: String): String {
        return activity.triggerLocalCopy(jsonPayload)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalPaste(): String {
        return activity.triggerLocalPaste()
    }

    @Suppress("unused")
    @JavascriptInterface
    fun isLocalFsEnabled(): Boolean {
        return XIntentClient.isLocalFsEnabled(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalPickFile(): String {
        return activity.triggerLocalPickFile()
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalSaveAs(jsonPayload: String): String {
        return activity.triggerLocalSaveAs(jsonPayload)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun fetchApiTagsJson(): String {
        return runBlocking {
            val res = XIntentClient.fetchApiTags(activity.applicationContext)
            if (res.success) res.responseBody else "{}"
        }
    }

    @Suppress("unused")
    @JavascriptInterface
    fun postIntent(namespace: String, action: String, appName: String, jsonPayload: String): String {
        return runBlocking {
            val res = XIntentClient.sendTextProcessIntent(
                context = activity.applicationContext,
                text = jsonPayload,
                targetApp = appName,
                namespace = namespace,
                action = action,
            )
            res.responseBody
        }
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

    var webViewRef: WebView? = remember { null }

    Column(modifier = modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(onClick = onClose) {
                Text("Close")
            }

            Text(
                text = " $appName / $cardName",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 8.dp),
            )

            Button(onClick = { webViewRef?.reload() }) {
                Text("Reload")
            }
        }

        AndroidView(
            factory = { ctx ->
                WebView(ctx).apply {
                    webViewClient = object : WebViewClient() {
                        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                            super.onPageStarted(view, url, favicon)
                            view?.evaluateJavascript(CardsActivity.INJECT_XINTENT_JS, null)
                        }

                        override fun onPageFinished(view: WebView?, url: String?) {
                            super.onPageFinished(view, url)
                            view?.evaluateJavascript(CardsActivity.INJECT_XINTENT_JS, null)
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

                    activity?.let {
                        addJavascriptInterface(XIntentJSBridge(it), "XIntentNative")
                    }

                    loadUrl(cardUrl)
                    webViewRef = this
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
    }
}
