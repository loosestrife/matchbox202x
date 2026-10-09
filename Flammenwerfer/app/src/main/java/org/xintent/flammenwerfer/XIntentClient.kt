package org.xintent.flammenwerfer

import android.content.Context
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

object XIntentClient {
    private const val TAG = "XIntentClient"
    private const val PREFS_NAME = "xintent_prefs"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_LOCAL_FS = "use_local_fs"
    private const val KEY_LOCAL_CLIPBOARD = "use_local_clipboard"
    private const val KEY_LOCAL_TTS = "use_local_tts"
    private const val KEY_LOCAL_AUDIO = "use_local_audio"
    const val DEFAULT_SERVER_URL = "http://10.0.2.2:12345"

    enum class WebSocketState {
        DISCONNECTED,
        CONNECTING,
        CONNECTED,
        ERROR
    }

    private var okHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .build()

    private var activeWebSocket: WebSocket? = null
    var webSocketState = WebSocketState.DISCONNECTED
        private set

    private val webSocketStateListeners = mutableSetOf<(WebSocketState) -> Unit>()

    fun addWebSocketStateListener(listener: (WebSocketState) -> Unit) {
        synchronized(webSocketStateListeners) {
            webSocketStateListeners.add(listener)
        }
        listener(webSocketState)
    }

    fun removeWebSocketStateListener(listener: (WebSocketState) -> Unit) {
        synchronized(webSocketStateListeners) {
            webSocketStateListeners.remove(listener)
        }
    }

    private fun updateWebSocketState(newState: WebSocketState) {
        webSocketState = newState
        val copy: List<(WebSocketState) -> Unit>
        synchronized(webSocketStateListeners) {
            copy = webSocketStateListeners.toList()
        }
        copy.forEach { it(newState) }
    }

    const val FLAMMENWERFER_MANIFEST = """[app]
id = "flammenwerfer-phone"

[intents]
"ui.Copy" = true
"ui.Paste" = true
"fs.PickFile" = true
"fs.SaveAs" = true

[XAudioSink]
name = "flammenwerfer-phone"
"""

    fun sendSysAdvertise(webSocket: WebSocket) {
        try {
            val advertiseJson = JSONObject().apply {
                put("event", "sys.Advertise")
                put("app", "flammenwerfer-phone")
                put("manifest", FLAMMENWERFER_MANIFEST)
            }
            webSocket.send(advertiseJson.toString())
            addLog("[sys.Advertise] Advertised flammenwerfer-phone capabilities (ui.Copy, ui.Paste, fs.PickFile, fs.SaveAs, XAudioNode)")
            Log.i(TAG, "Sent sys.Advertise over WebSocket")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending sys.Advertise", e)
            addLog("[sys.Advertise 🔴] Failed to send advertisement: ${e.message}")
        }
    }

    fun connectWebSocket(context: Context) {
        if (webSocketState == WebSocketState.CONNECTED || webSocketState == WebSocketState.CONNECTING) {
            return
        }

        val httpUrl = getServerUrl(context)
        val wsUrl = httpUrl.replace("http://", "ws://").replace("https://", "wss://") + "/xaudio?XAudioSink=flammenwerfer-phone"

        addLog("[WebSocket] Connecting to Remote Intents at $wsUrl...")
        updateWebSocketState(WebSocketState.CONNECTING)

        val request = Request.Builder()
            .url(wsUrl)
            .build()

        activeWebSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "WebSocket connected to $wsUrl")
                addLog("[WebSocket 🟢] Connected to $wsUrl")
                updateWebSocketState(WebSocketState.CONNECTED)
                sendSysAdvertise(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                Log.i(TAG, "WebSocket text message: $text")
                addLog("[WebSocket 📩] Remote message: $text")
                try {
                    val json = JSONObject(text)
                    val intentName = json.optString("intent", json.optString("event", ""))
                    val txId = json.optInt("txId", 0)

                    if (intentName == "xaudio.PlaySoundBlob" || intentName == "XAudioPlay" || intentName == "xaudio.Play") {
                        if (isLocalAudioEnabled(context)) {
                            val resJsonStr = CardsActivity.instance?.triggerLocalAudioPlay(text) ?: JSONObject().apply {
                                put("event", "XAudioPlayResponseV0")
                                put("status", 200)
                                if (txId != 0) put("txId", txId)
                            }.toString()

                            val resObj = JSONObject(resJsonStr).apply {
                                put("event", "XAudioPlayResponseV0")
                                if (txId != 0) put("txId", txId)
                                put("status", 200)
                            }
                            webSocket.send(resObj.toString())
                            addLog("[XAudioSink 🔊] Sent XAudioPlayResponseV0 for txId $txId over WebSocket")
                        }
                    } else if (intentName == "xaudio.ControlStream" || intentName == "XAudioControl") {
                        if (isLocalAudioEnabled(context)) {
                            val resJsonStr = CardsActivity.instance?.triggerLocalAudioControl(text) ?: JSONObject().apply {
                                put("event", "XAudioControlResponseV0")
                                put("status", 200)
                                if (txId != 0) put("txId", txId)
                            }.toString()
                            webSocket.send(resJsonStr)
                            addLog("[XAudioSink 🔊] Sent XAudioControlResponseV0 for txId $txId over WebSocket")
                        }
                    }
                } catch (_: Exception) {}
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "WebSocket closing $code: $reason")
                addLog("[WebSocket 🟡] Closing ($code): $reason")
                updateWebSocketState(WebSocketState.DISCONNECTED)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "WebSocket closed $code: $reason")
                updateWebSocketState(WebSocketState.DISCONNECTED)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "WebSocket failure: ${t.message}", t)
                addLog("[WebSocket 🔴] Connection failed: ${t.message ?: "Network error"}")
                updateWebSocketState(WebSocketState.ERROR)
            }
        })
    }

    fun disconnectWebSocket() {
        addLog("[WebSocket ⏹] Disconnecting...")
        activeWebSocket?.close(1000, "User requested disconnect")
        activeWebSocket = null
        updateWebSocketState(WebSocketState.DISCONNECTED)
    }

    private val logListeners = mutableSetOf<() -> Unit>()
    private val logEntries = mutableListOf<String>()

    fun isLocalAudioEnabled(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_LOCAL_AUDIO, true)
    }

    fun setLocalAudioEnabled(context: Context, enabled: Boolean) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean(KEY_LOCAL_AUDIO, enabled).apply()
    }

    fun isLocalTtsEnabled(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_LOCAL_TTS, false)
    }

    fun setLocalTtsEnabled(context: Context, enabled: Boolean) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean(KEY_LOCAL_TTS, enabled).apply()
    }

    fun isLocalClipboardEnabled(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_LOCAL_CLIPBOARD, false)
    }

    fun setLocalClipboardEnabled(context: Context, enabled: Boolean) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean(KEY_LOCAL_CLIPBOARD, enabled).apply()
    }

    fun isLocalFsEnabled(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_LOCAL_FS, false)
    }

    fun setLocalFsEnabled(context: Context, enabled: Boolean) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean(KEY_LOCAL_FS, enabled).apply()
    }

    fun getLogHistory(): String {
        synchronized(logEntries) {
            return if (logEntries.isEmpty()) {
                "No requests dispatched yet."
            } else {
                logEntries.joinToString("\n----------------------------------------\n")
            }
        }
    }

    fun addLog(entry: String) {
        val timeStr = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        val formattedEntry = "[$timeStr] $entry"
        val listenersCopy: List<() -> Unit>
        synchronized(logEntries) {
            logEntries.add(0, formattedEntry)
            if (logEntries.size > 30) {
                logEntries.removeAt(logEntries.size - 1)
            }
        }
        synchronized(logListeners) {
            listenersCopy = logListeners.toList()
        }
        listenersCopy.forEach { it() }
    }

    fun addLogListener(listener: () -> Unit) {
        synchronized(logListeners) {
            logListeners.add(listener)
        }
    }

    fun removeLogListener(listener: () -> Unit) {
        synchronized(logListeners) {
            logListeners.remove(listener)
        }
    }

    fun getServerUrl(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
    }

    fun setServerUrl(context: Context, url: String) {
        val cleanUrl = url.trim().removeSuffix("/")
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_SERVER_URL, cleanUrl).apply()
    }

    fun getTargetApp(context: Context, actionIndex: Int): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val defaultApp = when (actionIndex) {
            1 -> "cool-clips"
            2 -> "cool-bible"
            3 -> "cool-clips"
            else -> "cool-clips"
        }
        return prefs.getString("target_app_action_$actionIndex", defaultApp) ?: defaultApp
    }

    fun setTargetApp(context: Context, actionIndex: Int, appName: String) {
        val cleanApp = appName.trim()
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString("target_app_action_$actionIndex", cleanApp).apply()
    }

    data class AppCardModel(
        val appId: String,
        val appName: String,
        val description: String = "",
        val mainCard: String = "index",
        val cards: List<String> = listOf("index"),
    )

    fun parseAppCards(tagsJsonResponse: String): List<AppCardModel> {
        val appCards = mutableListOf<AppCardModel>()
        val jsonObjects = extractJsonObjects(tagsJsonResponse)
        if (jsonObjects.isEmpty()) return appCards

        val rootJson = jsonObjects.first()
        if (rootJson.has("apps")) {
            val appsJson = rootJson.getJSONObject("apps")
            val keys = appsJson.keys()
            while (keys.hasNext()) {
                val appKey = keys.next()
                val appObj = appsJson.getJSONObject(appKey)
                val name = appObj.optString("name", appKey)
                val description = appObj.optString("description", "")
                val mainCard = appObj.optString("mainCard", "index")

                val cardsList = mutableListOf<String>()
                if (appObj.has("cards")) {
                    val cardsArray = appObj.getJSONArray("cards")
                    for (i in 0 until cardsArray.length()) {
                        cardsList.add(cardsArray.getString(i))
                    }
                }
                if (cardsList.isEmpty()) {
                    cardsList.add(mainCard)
                }

                appCards.add(
                    AppCardModel(
                        appId = appKey,
                        appName = name,
                        description = description,
                        mainCard = mainCard,
                        cards = cardsList,
                    ),
                )
            }
        }
        return appCards
    }

    data class Result(
        val success: Boolean,
        val statusCode: Int = 0,
        val responseBody: String = "",
        val replacementText: String? = null,
        val errorMessage: String? = null,
    )

    fun extractJsonObjects(text: String): List<JSONObject> {
        val results = mutableListOf<JSONObject>()
        var depth = 0
        var start = -1
        for (i in text.indices) {
            when (text[i]) {
                '{' -> {
                    if (depth == 0) start = i
                    depth++
                }
                '}' -> {
                    if (depth > 0) {
                        depth--
                        if (depth == 0) {
                            val candidate = text.substring(start, i + 1)
                            try {
                                results.add(JSONObject(candidate))
                            } catch (_: Exception) {
                            }
                            start = -1
                        }
                    }
                }
            }
        }
        return results
    }

    fun extractReplacementText(responseBody: String): String? {
        val trimmed = responseBody.trim()
        if (trimmed.isBlank()) return null

        val jsonObjects = extractJsonObjects(trimmed)
        if (jsonObjects.isNotEmpty()) {
            for (json in jsonObjects.reversed()) {
                if (json.has("text")) {
                    val textVal = json.getString("text")
                    if (textVal.isNotBlank()) return textVal
                }
                if (json.has("replacementText")) {
                    val textVal = json.getString("replacementText")
                    if (textVal.isNotBlank()) return textVal
                }
                if (json.has("replacement")) {
                    val textVal = json.getString("replacement")
                    if (textVal.isNotBlank()) return textVal
                }
            }
            return null
        }

        return trimmed
    }

    fun parseMultipartRawBytes(rawBytes: ByteArray): Pair<List<JSONObject>, ByteArray?> {
        if (rawBytes.isEmpty()) return Pair(emptyList(), null)

        val rawStr = try { String(rawBytes, Charsets.ISO_8859_1) } catch (_: Exception) { "" }
        if (!rawStr.contains("MatchboxFrameBoundary")) {
            val jsonList = extractJsonObjects(String(rawBytes, Charsets.UTF_8))
            val audio = extractAudioBytesFromRawResponse(rawBytes)
            return Pair(jsonList, audio)
        }

        val jsonList = mutableListOf<JSONObject>()
        var extractedAudio: ByteArray? = null

        val boundaryLine = rawStr.lines().firstOrNull { it.contains("MatchboxFrameBoundary") }?.trim() ?: ""
        var boundary = boundaryLine
        if (boundary.startsWith("--")) boundary = boundary.substring(2)
        if (boundary.endsWith("--")) boundary = boundary.substring(0, boundary.length - 2)
        boundary = boundary.trim()

        if (boundary.isBlank()) {
            val jsonListFallback = extractJsonObjects(String(rawBytes, Charsets.UTF_8))
            val audioFallback = extractAudioBytesFromRawResponse(rawBytes)
            return Pair(jsonListFallback, audioFallback)
        }

        val boundaryBytes = ("--" + boundary).toByteArray(Charsets.ISO_8859_1)
        val parts = splitBytesByDelimiter(rawBytes, boundaryBytes)

        for (partBytes in parts) {
            if (partBytes.isEmpty()) continue
            val headerSep = findSequence(partBytes, "\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
            val headerSepLen = if (headerSep != -1) 4 else {
                val altSep = findSequence(partBytes, "\n\n".toByteArray(Charsets.ISO_8859_1))
                if (altSep != -1) 2 else -1
            }

            val bodyBytes = if (headerSep != -1) {
                partBytes.copyOfRange(headerSep + headerSepLen, partBytes.size)
            } else {
                partBytes
            }

            if (bodyBytes.isEmpty()) continue

            val bodyStr = try { String(bodyBytes, Charsets.UTF_8).trim() } catch (_: Exception) { "" }
            if (bodyStr.startsWith("{") && bodyStr.endsWith("}")) {
                try {
                    jsonList.add(JSONObject(bodyStr))
                    continue
                } catch (_: Exception) {}
            }

            val audioFromPart = extractAudioBytesFromRawResponse(bodyBytes)
            if (audioFromPart != null && audioFromPart.size > 10) {
                extractedAudio = audioFromPart
                break
            }
        }

        return Pair(jsonList, extractedAudio)
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

    private fun splitBytesByDelimiter(source: ByteArray, delimiter: ByteArray): List<ByteArray> {
        val result = mutableListOf<ByteArray>()
        var start = 0
        while (true) {
            if (start >= source.size) break
            val pos = findSequence(source.copyOfRange(start, source.size), delimiter)
            if (pos == -1) {
                if (start < source.size) {
                    result.add(source.copyOfRange(start, source.size))
                }
                break
            }
            val actualPos = start + pos
            if (actualPos > start) {
                result.add(source.copyOfRange(start, actualPos))
            }
            start = actualPos + delimiter.size
        }
        return result
    }

    fun extractAudioBytesFromRawResponse(rawBytes: ByteArray): ByteArray? {
        if (rawBytes.isEmpty()) return null

        // 1. Direct WAV / audio magic bytes
        if (rawBytes.size >= 4 && rawBytes[0] == 'R'.code.toByte() && rawBytes[1] == 'I'.code.toByte()) {
            return rawBytes
        }
        if (rawBytes.size >= 3 && rawBytes[0] == 'I'.code.toByte() && rawBytes[1] == 'D'.code.toByte() && rawBytes[2] == '3'.code.toByte()) return rawBytes
        if (rawBytes.size >= 4 && rawBytes[0] == 'O'.code.toByte() && rawBytes[1] == 'g'.code.toByte()) return rawBytes
        if (rawBytes.size >= 4 && rawBytes[0] == 'f'.code.toByte() && rawBytes[1] == 'L'.code.toByte()) return rawBytes

        // 2. Find HTTP-style headers in byte buffer at byte-level
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

                val strBody = try { String(bodyBytes, Charsets.UTF_8).trim() } catch (_: Exception) { "" }
                if (strBody.startsWith("{") && strBody.endsWith("}")) {
                    try {
                        val respJson = JSONObject(strBody)
                        val blobObj = respJson.optJSONObject("blob")
                        if (blobObj != null && blobObj.has("data")) {
                            return Base64.decode(blobObj.getString("data"), Base64.DEFAULT)
                        }
                    } catch (_: Exception) {}
                }

                return bodyBytes
            }
        }

        // 3. Try parsing JSON body directly
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

        // 4. Try Base64 string fallback
        try {
            val decoded = Base64.decode(respText, Base64.DEFAULT)
            if (decoded.isNotEmpty() && decoded.size > 10) {
                return decoded
            }
        } catch (_: Exception) {}

        return rawBytes
    }

    suspend fun fetchApiTags(context: Context): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/api/tags"

        val logPrefix = "[GET /api/tags]"
        addLog("$logPrefix Fetching desktop services & tags...")

        try {
            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8000
                readTimeout = 15000
                setRequestProperty("Accept", "application/json")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream

            val responseTextBuilder = StringBuilder()
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val buffer = CharArray(1024)
            var bytesRead: Int

            while (reader.read(buffer).also { bytesRead = it } != -1) {
                responseTextBuilder.appendRange(buffer, 0, bytesRead)
                val currentText = responseTextBuilder.toString().trim()
                if (currentText.startsWith("{") && currentText.endsWith("}")) break
            }

            val responseText = responseTextBuilder.toString()
            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.first().toString(2)
            } else {
                responseText.ifBlank { "(Empty tags response)" }
            }

            Log.i(TAG, "Fetched /api/tags [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode)")
                Result(success = true, statusCode = responseCode, responseBody = formattedDisplay)
            } else {
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(success = false, statusCode = responseCode, responseBody = formattedDisplay, errorMessage = "HTTP $responseCode")
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error fetching /api/tags from $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(success = false, errorMessage = errorDetail)
        }
    }

    suspend fun sendTextToSpeechIntent(
        context: Context,
        text: String,
        targetApp: String = "cool-tts",
        voice: String = "default",
        speed: Float = 1.0f,
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/ui/TextToSpeech?app=$targetApp"

        val logPrefix = "[ui.TextToSpeech -> $targetApp]"
        addLog("$logPrefix Synthesizing text:\n\"$text\"")

        try {
            val jsonBody = JSONObject().apply {
                put("intent", "ui.TextToSpeech")
                put("app", targetApp)
                put("text", text)
                put("voice", voice)
                put("speed", speed)
                put("Accept", "*")
                put("controlWord", 1)
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "audio/wav, application/json, */*")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
                setRequestProperty("X-Channel-Control", "SYN")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonBody.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream

            val rawBytes = (inputStream ?: "".byteInputStream()).readBytes()
            val (jsonObjects, parsedAudio) = parseMultipartRawBytes(rawBytes)
            var audioBytes: ByteArray? = parsedAudio

            val responseText = try { String(rawBytes, Charsets.UTF_8) } catch (_: Exception) { "" }
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.joinToString("\n---\n") { it.toString(2) }
            } else {
                responseText.ifBlank { "(Audio or stream response)" }
            }

            if (audioBytes == null || audioBytes.isEmpty()) {
                for (json in jsonObjects) {
                    if (json.has("data") && json.optString("_dataType") == "base64") {
                        audioBytes = Base64.decode(json.getString("data"), Base64.DEFAULT)
                        break
                    } else if (json.has("blob")) {
                        val blobObj = json.optJSONObject("blob")
                        if (blobObj != null && blobObj.optString("_dataType") == "base64") {
                            audioBytes = Base64.decode(blobObj.getString("data"), Base64.DEFAULT)
                            break
                        }
                    }
                }
            }

            if (audioBytes == null || audioBytes.isEmpty()) {
                val blobIdMatch = Regex("""(?:X-Attached-Blob-Id|X-Blob-Id|data_blob|dataBlob|payloadBlob)\s*[:=]\s*"?(\d+)""", RegexOption.IGNORE_CASE)
                    .find(responseText)
                val blobId = blobIdMatch?.groupValues?.get(1) ?: ""

                if (blobId.isNotBlank() && blobId != "0") {
                    try {
                        val conn = (URL("$baseUrl/xblob/$blobId").openConnection() as HttpURLConnection).apply {
                            requestMethod = "GET"
                            connectTimeout = 5000
                            readTimeout = 10000
                        }
                        if (conn.responseCode in 200..299) {
                            val blobRawBytes = conn.inputStream.readBytes()
                            audioBytes = extractAudioBytesFromRawResponse(blobRawBytes) ?: blobRawBytes
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Error fetching xblob $blobId for TTS", e)
                    }
                }
            }

            Log.i(TAG, "Sent ui.TextToSpeech to $targetApp [$responseCode]: parsed ${jsonObjects.size} JSON blocks. AudioBytes size: ${audioBytes?.size}")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode):\n$formattedDisplay")
                Result(success = true, statusCode = responseCode, responseBody = formattedDisplay, replacementText = audioBytes?.let { Base64.encodeToString(it, Base64.DEFAULT) })
            } else {
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(success = false, statusCode = responseCode, responseBody = formattedDisplay, errorMessage = "HTTP $responseCode")
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending ui.TextToSpeech to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(success = false, errorMessage = errorDetail)
        }
    }

    suspend fun sendPickFileIntent(
        context: Context,
        holdOpenForWrite: Boolean = true,
        targetApp: String = "cool-clips",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/fs/PickFile?app=$targetApp"

        val logPrefix = "[fs.PickFile -> $targetApp]"
        addLog("$logPrefix Requesting PickFile (holdOpenForWrite=$holdOpenForWrite)")

        try {
            val jsonBody = JSONObject().apply {
                put("intent", "fs.PickFile")
                put("app", targetApp)
                put("holdOpenForWrite", holdOpenForWrite)
                put("Accept", "*")
                put("controlWord", 1)
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "*/*")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
                setRequestProperty("X-Channel-Control", "SYN")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonBody.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream

            val responseTextBuilder = StringBuilder()
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val buffer = CharArray(1024)
            var bytesRead: Int

            while (reader.read(buffer).also { bytesRead = it } != -1) {
                responseTextBuilder.appendRange(buffer, 0, bytesRead)
                val currentText = responseTextBuilder.toString().trim()
                if (currentText.startsWith("{") && currentText.endsWith("}")) break
            }

            val responseText = responseTextBuilder.toString()
            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.joinToString("\n---\n") { it.toString(2) }
            } else {
                responseText.ifBlank { "(Empty response body)" }
            }

            Log.i(TAG, "Sent fs.PickFile to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode):\n$formattedDisplay")
                Result(success = true, statusCode = responseCode, responseBody = formattedDisplay)
            } else {
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(success = false, statusCode = responseCode, responseBody = formattedDisplay, errorMessage = "HTTP $responseCode")
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending fs.PickFile to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(success = false, errorMessage = errorDetail)
        }
    }

    suspend fun sendXBlobBroadcast(
        context: Context,
        blobId: String,
        name: String,
        type: String,
        size: Long,
        dataType: String,
        data: String,
        targetApp: String = "cool-clips",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/sys/XBlobBroadcast?app=$targetApp"

        val logPrefix = "[XBlobBroadcast -> $targetApp]"
        addLog("$logPrefix Broadcasting blob $blobId: $name ($type, $size bytes)")

        try {
            val blobJson = JSONObject().apply {
                put("name", name)
                put("type", type)
                put("size", size)
                put("_dataType", dataType)
                put("data", data)
            }

            val jsonBody = JSONObject().apply {
                put("event", "XBlobBroadcast")
                put("blobId", blobId)
                put("app", targetApp)
                put("blob", blobJson)
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonBody.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream

            val responseTextBuilder = StringBuilder()
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val buffer = CharArray(1024)
            var bytesRead: Int

            while (reader.read(buffer).also { bytesRead = it } != -1) {
                responseTextBuilder.appendRange(buffer, 0, bytesRead)
                val currentText = responseTextBuilder.toString().trim()
                if (currentText.startsWith("{") && currentText.endsWith("}")) break
            }

            val responseText = responseTextBuilder.toString()
            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.joinToString("\n---\n") { it.toString(2) }
            } else {
                responseText.ifBlank { "(Empty response body)" }
            }

            Log.i(TAG, "Sent XBlobBroadcast to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode):\n$formattedDisplay")
                Result(success = true, statusCode = responseCode, responseBody = formattedDisplay)
            } else {
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(success = false, statusCode = responseCode, responseBody = formattedDisplay, errorMessage = "HTTP $responseCode")
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending XBlobBroadcast to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(success = false, errorMessage = errorDetail)
        }
    }

    suspend fun sendSaveAsIntent(
        context: Context,
        name: String,
        type: String,
        size: Long,
        dataType: String,
        data: String,
        targetApp: String = "cool-clips",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/fs/SaveAs?app=$targetApp"

        val logPrefix = "[fs.SaveAs -> $targetApp]"
        addLog("$logPrefix Saving file: $name ($type, $size bytes)")

        try {
            val blobJson = JSONObject().apply {
                put("name", name)
                put("type", type)
                put("size", size)
                put("_dataType", dataType)
                put("data", data)
            }

            val jsonBody = JSONObject().apply {
                put("intent", "fs.SaveAs")
                put("app", targetApp)
                put("blob", blobJson)
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonBody.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream
            }

            val responseTextBuilder = StringBuilder()
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val buffer = CharArray(1024)
            var bytesRead: Int

            while (reader.read(buffer).also { bytesRead = it } != -1) {
                responseTextBuilder.appendRange(buffer, 0, bytesRead)
                val currentText = responseTextBuilder.toString().trim()
                if (currentText.startsWith("{") && currentText.endsWith("}")) break
            }

            val responseText = responseTextBuilder.toString()
            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.joinToString("\n---\n") { it.toString(2) }
            } else {
                responseText.ifBlank { "(Empty response body)" }
            }

            Log.i(TAG, "Sent fs.SaveAs to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode):\n$formattedDisplay")
                Result(
                    success = true,
                    statusCode = responseCode,
                    responseBody = formattedDisplay,
                )
            } else {
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(
                    success = false,
                    statusCode = responseCode,
                    responseBody = formattedDisplay,
                    errorMessage = "HTTP $responseCode: $formattedDisplay",
                )
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending fs.SaveAs to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(
                success = false,
                errorMessage = errorDetail,
            )
        }
    }

    suspend fun sendTextProcessIntent(
        context: Context,
        text: String,
        targetApp: String,
        canReplace: Boolean = true,
        namespace: String = "ui",
        action: String = "TextProcess",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/$namespace/$action?app=$targetApp"

        val logPrefix = "[$namespace.$action -> $targetApp]"
        addLog("$logPrefix Dispatching text:\n\"$text\"")

        try {
            val jsonBody = JSONObject().apply {
                put("intent", "$namespace.$action")
                put("app", targetApp)
                put("text", text)
                if (canReplace) {
                    put("replace", true)
                    put("Accept", "*")
                    put("controlWord", 1)
                }
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 15000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
                if (canReplace) {
                    setRequestProperty("Accept", "*/*")
                    setRequestProperty("X-Channel-Control", "SYN")
                } else {
                    setRequestProperty("Accept", "application/json")
                }
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonBody.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream
            }

            val responseTextBuilder = StringBuilder()
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val buffer = CharArray(1024)
            var bytesRead: Int

            while (reader.read(buffer).also { bytesRead = it } != -1) {
                responseTextBuilder.appendRange(buffer, 0, bytesRead)
                val currentText = responseTextBuilder.toString().trim()

                if (currentText.startsWith("{") && currentText.endsWith("}")) {
                    break
                }
                if (currentText.contains("--MatchboxFrameBoundary_") && currentText.endsWith("--")) {
                    break
                }
            }

            val responseText = responseTextBuilder.toString()
            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.joinToString("\n---\n") { it.toString(2) }
            } else {
                responseText.ifBlank { "(Empty response body)" }
            }

            Log.i(TAG, "Sent intent to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                val extracted = if (canReplace) extractReplacementText(responseText) else null
                val result = Result(
                    success = true,
                    statusCode = responseCode,
                    responseBody = formattedDisplay,
                    replacementText = extracted,
                )

                val logText = if (!extracted.isNullOrBlank()) {
                    "$logPrefix SUCCESS ($responseCode):\n$formattedDisplay\n\n[Replacement Text]: $extracted"
                } else {
                    "$logPrefix SUCCESS ($responseCode):\n$formattedDisplay"
                }
                addLog(logText)
                result
            } else {
                val errorMsg = "HTTP $responseCode: $formattedDisplay"
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(
                    success = false,
                    statusCode = responseCode,
                    responseBody = formattedDisplay,
                    errorMessage = errorMsg,
                )
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending intent to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(
                success = false,
                errorMessage = errorDetail,
            )
        }
    }
}
