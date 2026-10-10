package org.xintent.flammenwerfer

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.OpenableColumns
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import android.webkit.JavascriptInterface
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
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.xintent.flammenwerfer.ui.theme.FlammenwerferTheme
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

class CardsActivity : ComponentActivity() {

    companion object {
        var instance: CardsActivity? = null
        const val EXTRA_APP_NAME = "extra_app_name"
        const val EXTRA_CARD_NAME = "extra_card_name"

        const val INJECT_XINTENT_JS = """
(function() {
  if (window.xintent && typeof window.xintent.intent === 'function' && window.xaudio) return;

  window.xintent = window.xintent || {
    SYN: 1,
    FIN: 2,
    SYN_FIN: 3,

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
          var rawRes = window.XIntentNative.handleLocalPickFile(JSON.stringify(payload || {}));
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

      var isXAudio = (intentName || '').indexOf('xaudio.') === 0 || (intentName || '').indexOf('XAudio') === 0;

      if (bodyData.controlWord === undefined && (bodyData.Accept || isXAudio)) {
        bodyData.controlWord = 1;
      }

      var headers = {
        'Content-Type': 'application/json',
        'Accept': (payload && payload.Accept) ? payload.Accept : '*/*',
        'X-Forwarded-By': 'flammenwerfer-web-card'
      };

      if (bodyData.controlWord !== undefined) {
        var ctrlStrings = [];
        if (bodyData.controlWord & 1) ctrlStrings.push('SYN');
        if (bodyData.controlWord & 2) ctrlStrings.push('FIN');
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

  window.xaudio = window.xaudio || {
    connectXAudioWs: function(onFrameHandler, sinkName) {
      this._wsListeners = this._wsListeners || [];
      if (typeof onFrameHandler === 'function') {
        this._wsListeners.push(onFrameHandler);
      }

      if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) {
        return this._ws;
      }

      var wsProtocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
      var host = window.location.host || 'localhost:12345';
      var sink = sinkName || 'user-desktop-speakers';
      var wsUrl = wsProtocol + '//' + host + '/xaudio?XAudioSink=' + encodeURIComponent(sink);

      try {
        var ws = new WebSocket(wsUrl, 'message/http');
        this._ws = ws;
        var self = this;

        ws.onopen = function() {
          console.log('[xaudio] Real-time message/http WebSocket connected to ' + wsUrl);
        };

        ws.onmessage = function(event) {
          try {
            var frame = null;
            if (typeof event.data === 'string' && (event.data.indexOf('Content-Type:') !== -1 || event.data.indexOf('MatchboxFrameBoundary') !== -1)) {
              var parts = window.xintent ? window.xintent.parseMultipartResponse(event.data) : [];
              if (parts.length > 0) {
                frame = parts[0].json || parts[0].body;
                if (parts.length > 1 && parts[1].body) {
                  frame = Object.assign({}, typeof frame === 'object' ? frame : { data: frame }, { blob: parts[1].body });
                }
              }
            } else {
              frame = JSON.parse(event.data);
            }
            if (frame) {
              for (var i = 0; i < self._wsListeners.length; i++) {
                try { self._wsListeners[i](frame); } catch (_) {}
              }
            }
          } catch (_) {}
        };

        ws.onclose = function() {
          self._ws = null;
        };

        return ws;
      } catch (err) {
        console.warn('[xaudio] Could not establish WebSocket:', err);
        return null;
      }
    },
    XAudioPlay: async function(cookieOrOptions, seqnum, sample) {
      var options = (typeof cookieOrOptions === 'object' && cookieOrOptions !== null) ? cookieOrOptions : {
        cookie: cookieOrOptions,
        seqnum: seqnum || 0,
        sample: sample || seqnum || 0
      };
      var cookie = options.cookie || options.Cookie || options.OutputId || 'default';
      var seq = options.seqnum !== undefined ? options.seqnum : (options.seq || 0);
      var blobId = options.sample || options.blob || options.blobId || options.BlobId;
      var app = options.app || 'localhost';

      var payload = Object.assign({
        intent: 'xaudio.PlaySoundBlob',
        app: app,
        OutputId: cookie,
        cookie: cookie,
        streamId: options.streamId || 1,
        seqnum: seq,
        sample: blobId,
        controlWord: options.controlWord || 1
      }, options);

      if (window.XIntentNative && typeof window.XIntentNative.isLocalAudioEnabled === 'function' && window.XIntentNative.isLocalAudioEnabled()) {
        var rawRes = window.XIntentNative.handleLocalAudioPlay(JSON.stringify(payload));
        return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      var ws = this.connectXAudioWs(null, app);
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(payload));
        } else {
          ws.addEventListener('open', function() {
            try { ws.send(JSON.stringify(payload)); } catch(_) {}
          }, { once: true });
        }
        return new Response(JSON.stringify({ status: 200, queued: true, seqnum: seq, via: 'websocket' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return window.xintent.intent('xaudio.PlaySoundBlob', payload, app);
    },
    prefetchSoundBlob: async function(options) {
      options = options || {};
      var app = options.app || 'localhost';
      var payload = Object.assign({
        intent: 'xaudio.PrefetchSoundBlob',
        app: app
      }, options);

      if (window.XIntentNative && typeof window.XIntentNative.isLocalAudioEnabled === 'function' && window.XIntentNative.isLocalAudioEnabled()) {
        var rawRes = window.XIntentNative.handleLocalPrefetch(JSON.stringify(payload));
        return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return window.xintent.intent('xaudio.PrefetchSoundBlob', payload, app);
    },
    controlStream: async function(options) {
      options = options || {};
      var command = typeof options === 'string' ? options : (options.command || 'stop');
      var app = (typeof options === 'object' && options.app) ? options.app : 'localhost';
      return window.xintent.intent('xaudio.ControlStream', Object.assign({
        intent: 'xaudio.ControlStream',
        command: command,
        app: app
      }, typeof options === 'object' ? options : {}), app);
    },
    seekStream: async function(options) {
      options = options || {};
      var app = options.app || 'localhost';
      return window.xintent.intent('xaudio.SeekStream', Object.assign({
        intent: 'xaudio.SeekStream',
        app: app
      }, options), app);
    }
  };

  console.log('[Flammenwerfer] Attached window.xintent and window.xaudio runtime library.');
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
                    type = acceptMime
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this
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

    data class LocalAudioChunk(
        val seqnum: Int,
        val streamId: Int,
        val cookie: String,
        val tempAudioFile: File,
        val sizeBytes: Int,
    )

    var cardWebView: WebView? = null
    private val localAudioQueue = ConcurrentLinkedQueue<LocalAudioChunk>()
    private var isLocalAudioPlaying = false
    private var localMediaPlayer: MediaPlayer? = null

    var isPinned by mutableStateOf(false)
        private set

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

    private fun playNextLocalAudioChunk() {
        val chunk = localAudioQueue.poll()
        if (chunk == null) {
            isLocalAudioPlaying = false
            return
        }

        isLocalAudioPlaying = true

        try {
            localMediaPlayer?.release()
            localMediaPlayer = MediaPlayer().apply {
                setWakeMode(applicationContext, PowerManager.PARTIAL_WAKE_LOCK)
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                setDataSource(chunk.tempAudioFile.absolutePath)
                setOnCompletionListener { _ ->
                    XIntentClient.addLog("[xaudio.PlaySoundBlob] Finished playing seq #${chunk.seqnum} on phone speaker")

                    val responseJson = JSONObject().apply {
                        put("event", "XAudioPlayResponseV0")
                        put("intent", "XAudioPlayResponseV0")
                        put("status", 200)
                        put("cookie", chunk.cookie)
                        put("OutputId", chunk.cookie)
                        put("streamId", chunk.streamId)
                        put("seqnum", chunk.seqnum)
                    }

                    dispatchJsXAudioResponse(responseJson)

                    try { chunk.tempAudioFile.delete() } catch (_: Exception) {}

                    playNextLocalAudioChunk()
                }
                setOnErrorListener { _, what, _ ->
                    XIntentClient.addLog("[xaudio.PlaySoundBlob] MediaPlayer error $what on seq #${chunk.seqnum}")
                    try { chunk.tempAudioFile.delete() } catch (_: Exception) {}
                    playNextLocalAudioChunk()
                    true
                }
                prepare()
                start()
            }

            XIntentClient.addLog("[xaudio.PlaySoundBlob] Playing seq #${chunk.seqnum} on phone speaker (${chunk.sizeBytes} bytes)")
        } catch (e: Exception) {
            XIntentClient.addLog("[xaudio.PlaySoundBlob] Error playing seq #${chunk.seqnum}: ${e.message}")
            try { chunk.tempAudioFile.delete() } catch (_: Exception) {}
            playNextLocalAudioChunk()
        }
    }

    private val localBlobCache = ConcurrentHashMap<String, File>()

    private fun extractAudioBytesFromResponse(rawBytes: ByteArray): ByteArray? {
        if (rawBytes.isEmpty()) return null

        if (rawBytes.size >= 4 && rawBytes[0] == 'R'.code.toByte() && rawBytes[1] == 'I'.code.toByte()) {
            return rawBytes
        }

        val sepPos = findSequence(rawBytes, "\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
        val sepLen = if (sepPos != -1) 4 else {
            val altPos = findSequence(rawBytes, "\n\n".toByteArray(Charsets.ISO_8859_1))
            if (altPos != -1) 2 else -1
        }

        if (sepPos != -1) {
            val headerText = try { String(rawBytes.copyOfRange(0, sepPos), Charsets.ISO_8859_1) } catch (_: Exception) { "" }
            if (headerText.contains("Content-Type:", ignoreCase = true) || headerText.contains("Content-Encoding:", ignoreCase = true) || headerText.contains("Content-Transfer-Encoding:", ignoreCase = true)) {
                val bodyBytes = rawBytes.copyOfRange(sepPos + sepLen, rawBytes.size)
                if (bodyBytes.isEmpty()) return null

                val isBase64 = headerText.contains("base64", ignoreCase = true)
                if (isBase64) {
                    return try {
                        val strBody = String(bodyBytes, Charsets.UTF_8).trim()
                        Base64.decode(strBody, Base64.DEFAULT)
                    } catch (_: Exception) {
                        bodyBytes
                    }
                }

                return bodyBytes
            }
        }

        val respText = try { String(rawBytes, Charsets.UTF_8).trim() } catch (_: Exception) { "" }

        if (respText.startsWith("{")) {
            return try {
                val respJson = JSONObject(respText)
                val blobDataObj = respJson.optJSONObject("blob")
                if (blobDataObj != null && blobDataObj.has("data")) {
                    Base64.decode(blobDataObj.getString("data"), Base64.DEFAULT)
                } else if (blobDataObj != null && blobDataObj.has("buffer")) {
                    Base64.decode(blobDataObj.getString("buffer"), Base64.DEFAULT)
                } else {
                    val rawBlobStr = respJson.optString("blob")
                    if (rawBlobStr.isNotBlank()) {
                        Base64.decode(rawBlobStr, Base64.DEFAULT)
                    } else null
                }
            } catch (_: Exception) {
                null
            }
        }

        try {
            val decoded = Base64.decode(respText, Base64.DEFAULT)
            if (decoded.isNotEmpty() && decoded.size > 10) {
                return decoded
            }
        } catch (_: Exception) {}

        return rawBytes
    }

    private fun findSequence(source: ByteArray, target: ByteArray): Int {
        if (target.isEmpty() || source.size < target.size) return -1
        for (i in 0..source.size - target.size) {
            var match = true
            for (j in target.indices) {
                if (source[i + j] != target[j]) {
                    match = false
                    break
                }
            }
            if (match) return i
        }
        return -1
    }

    fun triggerLocalPrefetch(jsonPayload: String): String {
        return try {
            val json = JSONObject(jsonPayload)
            val sampleId = json.optString("sample")
                .ifBlank { json.optString("blobId", json.optString("blob", "")) }

            if (sampleId.isNotBlank() && !localBlobCache.containsKey(sampleId)) {
                val serverUrl = XIntentClient.getServerUrl(applicationContext)
                val blobUrl = "$serverUrl/xblob/$sampleId"

                Executors.newSingleThreadExecutor().execute {
                    try {
                        val conn = (URL(blobUrl).openConnection() as HttpURLConnection).apply {
                            requestMethod = "GET"
                            connectTimeout = 5000
                            readTimeout = 10000
                        }
                        if (conn.responseCode in 200..299) {
                            val rawBytes = conn.inputStream.readBytes()
                            val audioBytes = extractAudioBytesFromResponse(rawBytes)
                            if (audioBytes != null && audioBytes.isNotEmpty()) {
                                val tempFile = File.createTempFile("flammen_prefetch_", ".wav", cacheDir)
                                FileOutputStream(tempFile).use { it.write(audioBytes) }
                                localBlobCache[sampleId] = tempFile
                                XIntentClient.addLog("[xaudio.PrefetchSoundBlob] Prefetched blob $sampleId (${audioBytes.size} bytes)")
                            }
                        }
                    } catch (e: Exception) {
                        Log.e("CardsActivity", "Error prefetching xblob $sampleId", e)
                    }
                }
            }

            JSONObject().apply {
                put("status", "ok")
                put("message", "Prefetch started for $sampleId")
            }.toString()
        } catch (e: Exception) {
            JSONObject().apply {
                put("status", "error")
                put("message", e.message ?: "Failed prefetch")
            }.toString()
        }
    }

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

            val sampleId = json.optString("sample")
                .ifBlank { json.optString("blobId", json.optString("blob", "")) }

            var tempAudioFile: File? = if (sampleId.isNotBlank()) localBlobCache.remove(sampleId) else null

            if (tempAudioFile == null && audioBytes == null && sampleId.isNotBlank()) {
                val serverUrl = XIntentClient.getServerUrl(applicationContext)
                val blobUrl = "$serverUrl/xblob/$sampleId"
                try {
                    val conn = (URL(blobUrl).openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        connectTimeout = 5000
                        readTimeout = 10000
                    }
                    if (conn.responseCode in 200..299) {
                        val rawBytes = conn.inputStream.readBytes()
                        audioBytes = extractAudioBytesFromResponse(rawBytes)
                    }
                } catch (e: Exception) {
                    Log.e("CardsActivity", "Error fetching xblob $sampleId from $blobUrl", e)
                }
            }

            if (tempAudioFile == null && audioBytes != null && audioBytes.isNotEmpty()) {
                tempAudioFile = File.createTempFile("flammen_audio_", ".wav", cacheDir)
                FileOutputStream(tempAudioFile).use { fos ->
                    fos.write(audioBytes)
                }
            }

            if (tempAudioFile != null && tempAudioFile.exists()) {
                val fileSize = tempAudioFile.length().toInt()
                val chunk = LocalAudioChunk(seqnum, streamId, cookie, tempAudioFile, fileSize)
                localAudioQueue.add(chunk)

                XIntentClient.addLog("[xaudio.PlaySoundBlob] Queued phone speaker audio seq #$seqnum ($fileSize bytes). Queue size: ${localAudioQueue.size}")

                synchronized(this) {
                    if (!isLocalAudioPlaying) {
                        playNextLocalAudioChunk()
                    }
                }

                JSONObject().apply {
                    put("status", "ok")
                    put("message", "XAudioPlay queued")
                    put("cookie", cookie)
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
                localAudioQueue.clear()
                localMediaPlayer?.stop()
                localMediaPlayer?.release()
                localMediaPlayer = null
                isLocalAudioPlaying = false
                XIntentClient.addLog("[xaudio.ControlStream] Stopped phone speaker audio playback & cleared queue")
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

    override fun onPause() {
        super.onPause()
        if (isPinned) {
            cardWebView?.onResume()
            cardWebView?.resumeTimers()
        }
    }

    override fun onStop() {
        super.onStop()
        if (isPinned) {
            cardWebView?.onResume()
            cardWebView?.resumeTimers()
        }
    }

    override fun onDestroy() {
        if (isPinned) {
            val serviceIntent = Intent(this, XIntentCardService::class.java).apply {
                action = XIntentCardService.ACTION_STOP_PINNED
            }
            try { startService(serviceIntent) } catch (_: Exception) {}
        }
        super.onDestroy()
        if (instance === this) {
            instance = null
        }
        localAudioQueue.clear()
        localMediaPlayer?.stop()
        localMediaPlayer?.release()
        localMediaPlayer = null
        isLocalAudioPlaying = false
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
    fun handleLocalPrefetch(jsonPayload: String): String {
        return activity.triggerLocalPrefetch(jsonPayload)
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
    fun handleLocalPickFile(jsonPayload: String): String {
        return activity.triggerLocalPickFile(jsonPayload)
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
                        it.cardWebView = this
                        addJavascriptInterface(XIntentJSBridge(it), "XIntentNative")
                    }

                    loadUrl(cardUrl)
                    webViewRef = this
                    activity?.cardWebView = this
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
    }
}
