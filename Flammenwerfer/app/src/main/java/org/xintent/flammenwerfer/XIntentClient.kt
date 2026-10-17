package org.xintent.flammenwerfer

import android.content.Context
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

object XIntentClient {
    private const val TAG = "XIntentClient"
    private const val PREFS_NAME = "xintent_prefs"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_HOSTNAME = "hostname"
    private const val KEY_UDP_PORT = "udp_wake_port"
    private const val KEY_LOCAL_FS = "use_local_fs"
    private const val KEY_LOCAL_CLIPBOARD = "use_local_clipboard"
    private const val KEY_LOCAL_TTS = "use_local_tts"
    private const val KEY_LOCAL_AUDIO = "use_local_audio"
    private const val KEY_DEFAULT_REMOTE_DEVICE = "default_remote_device"
    private const val KEY_AUDIO_ROUTING_MODE = "audio_routing_mode"
    private const val KEY_TTS_ROUTING_MODE = "tts_routing_mode"
    private const val KEY_CLIPBOARD_ROUTING_MODE = "clipboard_routing_mode"
    private const val KEY_FS_ROUTING_MODE = "fs_routing_mode"

    const val DEFAULT_SERVER_URL = "http://10.0.2.2:12345"
    const val DEFAULT_HOSTNAME = "user-phone"
    const val DEFAULT_UDP_PORT = 12346
    const val DEFAULT_REMOTE_DEVICE = "user-desktop"

    enum class WebSocketState {
        DISCONNECTED,
        CONNECTING,
        CONNECTED,
        ERROR
    }

    enum class UdpState {
        DISCONNECTED,
        LISTENING,
        ERROR
    }

    private fun createTrustAllOkHttpClient(): OkHttpClient {
        return try {
            val trustAllCerts = arrayOf<TrustManager>(
                object : X509TrustManager {
                    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
                }
            )
            val sslContext = SSLContext.getInstance("SSL")
            sslContext.init(null, trustAllCerts, SecureRandom())

            HttpsURLConnection.setDefaultSSLSocketFactory(sslContext.socketFactory)
            HttpsURLConnection.setDefaultHostnameVerifier { _, _ -> true }

            OkHttpClient.Builder()
                .sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as X509TrustManager)
                .hostnameVerifier { _, _ -> true }
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .build()
        } catch (e: Exception) {
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .build()
        }
    }

    private var okHttpClient = createTrustAllOkHttpClient()

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

    var udpState = UdpState.DISCONNECTED
        private set

    private val udpStateListeners = mutableSetOf<(UdpState) -> Unit>()

    fun addUdpStateListener(listener: (UdpState) -> Unit) {
        synchronized(udpStateListeners) {
            udpStateListeners.add(listener)
        }
        listener(udpState)
    }

    fun removeUdpStateListener(listener: (UdpState) -> Unit) {
        synchronized(udpStateListeners) {
            udpStateListeners.remove(listener)
        }
    }

    private fun updateUdpState(newState: UdpState) {
        udpState = newState
        val copy: List<(UdpState) -> Unit>
        synchronized(udpStateListeners) {
            copy = udpStateListeners.toList()
        }
        copy.forEach { it(newState) }
    }

    fun getUdpPort(context: Context): Int {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getInt(KEY_UDP_PORT, DEFAULT_UDP_PORT)
    }

    fun setUdpPort(context: Context, port: Int) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putInt(KEY_UDP_PORT, port).apply()
        startUdpWakeListener(context)
    }

    private var udpSocket: DatagramSocket? = null
    private var udpJob: Job? = null
    private val udpScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    fun startUdpWakeListener(context: Context) {
        stopUdpWakeListener()
        val port = getUdpPort(context)

        udpJob = udpScope.launch {
            try {
                val socket = DatagramSocket(port)
                udpSocket = socket
                updateUdpState(UdpState.LISTENING)
                addLog("[UDP 🟢] Listening for wake-up pings on UDP port $port...")

                val buffer = ByteArray(1024)
                while (isActive && !socket.isClosed) {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    val msg = String(packet.data, 0, packet.length, Charsets.UTF_8).trim()
                    val senderIp = packet.address?.hostAddress ?: "unknown"

                    addLog("[UDP 🔔] Received wake-up ping from $senderIp:$port: ${msg.ifBlank { "ping" }}")

                    if (webSocketState != WebSocketState.CONNECTED && webSocketState != WebSocketState.CONNECTING) {
                        addLog("[UDP 🔔] Opening WebSocket to bridge on demand...")
                        withContext(Dispatchers.Main) {
                            connectWebSocket(context.applicationContext)
                        }
                    }
                }
            } catch (e: Exception) {
                if (isActive) {
                    Log.e(TAG, "UDP wake listener error", e)
                    updateUdpState(UdpState.ERROR)
                    addLog("[UDP 🔴] Listener error on port $port: ${e.message ?: "Socket error"}")
                }
            } finally {
                updateUdpState(UdpState.DISCONNECTED)
            }
        }
    }

    fun stopUdpWakeListener() {
        try {
            udpSocket?.close()
        } catch (_: Exception) {}
        udpSocket = null
        udpJob?.cancel()
        udpJob = null
        updateUdpState(UdpState.DISCONNECTED)
    }

    private var wsIdleJob: Job? = null

    private fun resetWsIdleTimer(context: Context) {
        wsIdleJob?.cancel()
        wsIdleJob = CoroutineScope(Dispatchers.IO).launch {
            delay(60000) // 60s idle timeout
            if (webSocketState == WebSocketState.CONNECTED) {
                addLog("[WebSocket ⏱] Idle timeout (60s without traffic). Closing WebSocket to maintain 0 active WebSockets.")
                withContext(Dispatchers.Main) {
                    disconnectWebSocket()
                }
            }
        }
    }

    const val FLAMMENWERFER_MANIFEST = """[app]
id = "user-phone:flammenwerfer"

[intents]
"ui.Copy" = true
"ui.Paste" = true
"fs.PickFile" = true
"fs.SendTo" = true
"fs.SaveAs" = true

[XAudioSink]
name = "user-phone:flammenwerfer"
"""

    fun getHostname(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_HOSTNAME, DEFAULT_HOSTNAME) ?: DEFAULT_HOSTNAME
        return saved.ifBlank { DEFAULT_HOSTNAME }
    }

    fun setHostname(context: Context, hostname: String) {
        val cleanHostname = hostname.trim()
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_HOSTNAME, cleanHostname).apply()
    }

    fun getAdvertisedName(context: Context): String {
        val host = getHostname(context)
        return "$host:flammenwerfer"
    }

    fun getManifest(context: Context): String {
        val advertisedName = getAdvertisedName(context)
        return """[app]
id = "$advertisedName"

[intents]
"ui.Copy" = true
"ui.Paste" = true
"fs.PickFile" = true
"fs.SendTo" = true
"fs.SaveAs" = true

[XAudioSink]
name = "$advertisedName"
"""
    }

    fun sendBridgeAdvertise(context: Context, webSocket: WebSocket) {
        try {
            val advertisedName = getAdvertisedName(context)
            val manifest = getManifest(context)
            val advertiseJson = JSONObject().apply {
                put("event", "bridge.Advertise")
                put("app", advertisedName)
                put("manifest", manifest)
            }
            webSocket.send(advertiseJson.toString())
            addLog("[bridge.Advertise] Advertised $advertisedName capabilities (ui.Copy, ui.Paste, fs.PickFile, fs.SaveAs, XAudioNode)")
            Log.i(TAG, "Sent bridge.Advertise over WebSocket for $advertisedName")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending bridge.Advertise", e)
            addLog("[bridge.Advertise 🔴] Failed to send advertisement: ${e.message}")
        }
    }

    fun sendSysAdvertise(context: Context, webSocket: WebSocket) = sendBridgeAdvertise(context, webSocket)

    private fun handleWebSocketRawBytes(webSocket: WebSocket, rawBytes: ByteArray, context: Context) {
        resetWsIdleTimer(context)
        val (jsonList, audio) = parseMultipartRawBytes(rawBytes)
        for (json in jsonList) {
            val intentName = json.optString("intent", json.optString("event", ""))
            val txId = json.optInt("txId", 0)

            if (intentName == "xaudio.PlaySoundBlob" || intentName == "XAudioPlay" || intentName == "xaudio.Play") {
                if (isLocalAudioEnabled(context)) {
                    val resJsonStr = CardsActivity.instance?.triggerLocalAudioPlay(json.toString()) ?: JSONObject().apply {
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
                    val resJsonStr = CardsActivity.instance?.triggerLocalAudioControl(json.toString()) ?: JSONObject().apply {
                        put("event", "XAudioControlResponseV0")
                        put("status", 200)
                        if (txId != 0) put("txId", txId)
                    }.toString()
                    webSocket.send(resJsonStr)
                    addLog("[XAudioSink 🔊] Sent XAudioControlResponseV0 for txId $txId over WebSocket")
                }
            }
        }
    }

    fun connectWebSocket(context: Context) {
        if (webSocketState == WebSocketState.CONNECTED || webSocketState == WebSocketState.CONNECTING) {
            return
        }

        val httpUrl = getServerUrl(context)
        val advertisedName = getAdvertisedName(context)
        val wsUrl = httpUrl.replace("http://", "ws://").replace("https://", "wss://") + "/xaudio?XAudioSink=$advertisedName"

        addLog("[WebSocket] Connecting to Remote Intents at $wsUrl...")
        updateWebSocketState(WebSocketState.CONNECTING)

        val request = Request.Builder()
            .url(wsUrl)
            .addHeader("Sec-WebSocket-Protocol", "message-http")
            .build()

        activeWebSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "WebSocket connected to $wsUrl with message-http subprotocol")
                addLog("[WebSocket 🟢] Connected to $wsUrl (message-http)")
                updateWebSocketState(WebSocketState.CONNECTED)
                sendBridgeAdvertise(context, webSocket)
                resetWsIdleTimer(context)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleWebSocketRawBytes(webSocket, text.toByteArray(Charsets.UTF_8), context)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                handleWebSocketRawBytes(webSocket, bytes.toByteArray(), context)
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
                val bodyStr = try {
                    response?.body?.string()?.trim()
                } catch (_: Exception) {
                    null
                }
                val details = if (!bodyStr.isNullOrBlank()) {
                    "${t.message ?: "Network error"} | Server Response Body: $bodyStr"
                } else {
                    t.message ?: "Network error"
                }
                addLog("[WebSocket 🔴] Connection failed: $details")
                updateWebSocketState(WebSocketState.ERROR)
            }
        })
    }

    fun sendBridgeDeadvertise(context: Context, webSocket: WebSocket) {
        try {
            val advertisedName = getAdvertisedName(context)
            val deadvertiseJson = JSONObject().apply {
                put("event", "bridge.Deadvertise")
                put("app", advertisedName)
            }
            webSocket.send(deadvertiseJson.toString())
            addLog("[bridge.Deadvertise] Sent deadvertise for $advertisedName")
            Log.i(TAG, "Sent bridge.Deadvertise over WebSocket for $advertisedName")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending bridge.Deadvertise", e)
            addLog("[bridge.Deadvertise 🔴] Failed to send deadvertise: ${e.message}")
        }
    }

    fun sendSysDeadvertise(context: Context, webSocket: WebSocket) = sendBridgeDeadvertise(context, webSocket)

    fun disconnectWebSocket(context: Context? = null) {
        addLog("[WebSocket ⏹] Disconnecting...")
        activeWebSocket?.let { ws ->
            if (context != null) {
                sendBridgeDeadvertise(context, ws)
            }
            ws.close(1000, "User requested disconnect")
        }
        activeWebSocket = null
        updateWebSocketState(WebSocketState.DISCONNECTED)
    }

    private val logListeners = mutableSetOf<() -> Unit>()
    private val logEntries = mutableListOf<String>()

    fun getDefaultRemoteDevice(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_DEFAULT_REMOTE_DEVICE, DEFAULT_REMOTE_DEVICE) ?: DEFAULT_REMOTE_DEVICE
    }

    fun setDefaultRemoteDevice(context: Context, device: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_DEFAULT_REMOTE_DEVICE, device.ifBlank { DEFAULT_REMOTE_DEVICE }).apply()
    }

    fun getAudioRoutingMode(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_AUDIO_ROUTING_MODE, null)
        if (saved != null) return saved
        return if (prefs.getBoolean(KEY_LOCAL_AUDIO, true)) "doLocalAudioCapture" else "normal"
    }

    fun setAudioRoutingMode(context: Context, mode: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_AUDIO_ROUTING_MODE, mode).apply()
    }

    fun getTtsRoutingMode(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_TTS_ROUTING_MODE, null)
        if (saved != null) return saved
        return if (prefs.getBoolean(KEY_LOCAL_TTS, false)) "doLocalTtsCapture" else "normal"
    }

    fun setTtsRoutingMode(context: Context, mode: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_TTS_ROUTING_MODE, mode).apply()
    }

    fun getClipboardRoutingMode(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_CLIPBOARD_ROUTING_MODE, null)
        if (saved != null) return saved
        return if (prefs.getBoolean(KEY_LOCAL_CLIPBOARD, false)) "doLocalClipboardCapture" else "normal"
    }

    fun setClipboardRoutingMode(context: Context, mode: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_CLIPBOARD_ROUTING_MODE, mode).apply()
    }

    fun getFsRoutingMode(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_FS_ROUTING_MODE, null)
        if (saved != null) return saved
        return if (prefs.getBoolean(KEY_LOCAL_FS, false)) "doLocalFsCapture" else "normal"
    }

    fun setFsRoutingMode(context: Context, mode: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_FS_ROUTING_MODE, mode).apply()
    }

    fun isLocalAudioEnabled(context: Context): Boolean {
        return getAudioRoutingMode(context) == "doLocalAudioCapture"
    }

    fun setLocalAudioEnabled(context: Context, enabled: Boolean) {
        setAudioRoutingMode(context, if (enabled) "doLocalAudioCapture" else "normal")
    }

    fun isLocalTtsEnabled(context: Context): Boolean {
        return getTtsRoutingMode(context) == "doLocalTtsCapture"
    }

    fun setLocalTtsEnabled(context: Context, enabled: Boolean) {
        setTtsRoutingMode(context, if (enabled) "doLocalTtsCapture" else "normal")
    }

    fun isLocalClipboardEnabled(context: Context): Boolean {
        return getClipboardRoutingMode(context) == "doLocalClipboardCapture"
    }

    fun setLocalClipboardEnabled(context: Context, enabled: Boolean) {
        setClipboardRoutingMode(context, if (enabled) "doLocalClipboardCapture" else "normal")
    }

    fun isLocalFsEnabled(context: Context): Boolean {
        return getFsRoutingMode(context) == "doLocalFsCapture"
    }

    fun setLocalFsEnabled(context: Context, enabled: Boolean) {
        setFsRoutingMode(context, if (enabled) "doLocalFsCapture" else "normal")
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
        Log.i(TAG, entry)
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

    fun parseBlobId(value: Any?): Long? {
        if (value == null) return null
        if (value is Number) {
            val l = value.toLong()
            return if (l > 0) l else null
        }
        val str = value.toString().trim()
        if (str.isEmpty() || str == "0" || str == "0x0") return null
        if (str.startsWith("0x", ignoreCase = true)) {
            return try { str.substring(2).toLong(16) } catch (_: Exception) { null }
        }
        return try {
            val l = str.toLong()
            if (l > 0) l else null
        } catch (_: Exception) {
            try { str.toLong(16) } catch (_: Exception) { null }
        }
    }

    fun formatBlobIdHex(blobId: Long): String {
        if (blobId <= 0) return ""
        return "0x" + blobId.toString(16)
    }

    fun unlinkXBlob(baseUrl: String, blobId: Long) {
        if (blobId <= 0) {
            Log.e(TAG, "Attempt to unlink invalid blobId $blobId")
            return
        }
        val hexBlobId = formatBlobIdHex(blobId)
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

    data class SendToTarget(
        val appId: String,
        val name: String,
        val description: String = "",
    )

    fun parseSendToTargets(tagsJsonResponse: String): List<SendToTarget> {
        val targets = mutableListOf<SendToTarget>()
        val jsonObjects = extractJsonObjects(tagsJsonResponse)
        val foundAppIds = mutableSetOf<String>()

        for (rootJson in jsonObjects) {
            val intentsObj = rootJson.optJSONObject("intents")
            if (intentsObj != null) {
                val sendToApps = intentsObj.optJSONArray("fs.SendTo") ?: intentsObj.optJSONArray("fs.SaveAs")
                if (sendToApps != null) {
                    for (i in 0 until sendToApps.length()) {
                        val appId = sendToApps.optString(i)
                        if (appId.isNotBlank() && !foundAppIds.contains(appId)) {
                            foundAppIds.add(appId)
                            val appsObj = rootJson.optJSONObject("apps")
                            val appObj = appsObj?.optJSONObject(appId)
                            val friendlyName = appObj?.optString("name", appId) ?: appId
                            val desc = appObj?.optString("description", "Active Desktop Destination") ?: "Active Desktop Destination"
                            targets.add(SendToTarget(appId, friendlyName, desc))
                        }
                    }
                }
            }

            val appsJson = rootJson.optJSONObject("apps") ?: rootJson
            val keys = appsJson.keys()
            while (keys.hasNext()) {
                val appKey = keys.next()
                val appObj = appsJson.optJSONObject(appKey) ?: continue
                val name = appObj.optString("name", appKey)
                val description = appObj.optString("description", "")

                var isSendTo = appKey == "cool-clips" || appKey == "user-desktop"
                if (appObj.has("intents")) {
                    val appIntents = appObj.optJSONObject("intents")
                    if (appIntents != null && (appIntents.has("fs.SendTo") || appIntents.has("fs.SaveAs"))) {
                        isSendTo = true
                    }
                }

                if (isSendTo && !foundAppIds.contains(appKey)) {
                    foundAppIds.add(appKey)
                    targets.add(SendToTarget(appId = appKey, name = name, description = description))
                }
            }
        }

        if (targets.isEmpty()) {
            targets.add(SendToTarget("cool-clips", "Cool Clips (Desktop Clipboard & Files)", "Default Desktop Receiver"))
        }

        return targets
    }

    data class MediaPlayTarget(
        val appId: String,
        val name: String,
        val accept: String = "*/*",
        val description: String = "",
    )

    fun parseMediaPlayTargets(tagsJsonResponse: String): List<MediaPlayTarget> {
        val targets = mutableListOf<MediaPlayTarget>()
        val jsonObjects = extractJsonObjects(tagsJsonResponse)
        val foundAppIds = mutableSetOf<String>()

        fun processAppObject(appKey: String, appObj: JSONObject) {
            val name = appObj.optString("name", appKey)
            val description = appObj.optString("description", "")

            var isMediaPlay = appKey.startsWith("dlna-") || appKey == "user-desktop"
            var acceptStr = "*/*"

            if (appObj.has("intents")) {
                val intentsObj = appObj.optJSONObject("intents")
                if (intentsObj != null && intentsObj.has("media.Play")) {
                    isMediaPlay = true
                    val playObj = intentsObj.opt("media.Play")
                    if (playObj is JSONObject) {
                        acceptStr = playObj.optString("Accept", playObj.optString("accept", "*/*"))
                    } else if (playObj is String) {
                        acceptStr = playObj
                    }
                }
            }

            val manifestStr = appObj.optString("manifest", "")
            if (manifestStr.contains("media.Play")) {
                isMediaPlay = true
                if (acceptStr == "*/*") {
                    val acceptMatch = Regex("""Accept\s*=\s*"([^"]+)"""").find(manifestStr)
                    if (acceptMatch != null) {
                        acceptStr = acceptMatch.groupValues[1].replace("\\\"", "\"")
                    }
                }
            }

            if (isMediaPlay && !foundAppIds.contains(appKey)) {
                foundAppIds.add(appKey)
                targets.add(
                    MediaPlayTarget(
                        appId = appKey,
                        name = name,
                        accept = acceptStr,
                        description = description,
                    )
                )
            }
        }

        for (rootJson in jsonObjects) {
            val appsJson = if (rootJson.has("apps")) {
                rootJson.optJSONObject("apps")
            } else {
                rootJson
            }

            if (appsJson != null) {
                val keys = appsJson.keys()
                if (keys != null) {
                    while (keys.hasNext()) {
                        val appKey = keys.next()
                        val appObj = appsJson.optJSONObject(appKey)
                        if (appObj != null) {
                            processAppObject(appKey, appObj)
                        }
                    }
                }
            }
        }

        if (!foundAppIds.contains("user-desktop")) {
            targets.add(
                0,
                MediaPlayTarget(
                    appId = "user-desktop",
                    name = "User Desktop PC",
                    accept = "*/*",
                    description = "Default Desktop XIntent Device"
                )
            )
        }

        return targets
    }

    data class Result(
        val success: Boolean,
        val statusCode: Int = 0,
        val responseBody: String = "",
        val replacementText: String? = null,
        val errorMessage: String? = null,
        val rawBytes: ByteArray = ByteArray(0),
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

    fun extractFileFromPickFileResponse(rawBytes: ByteArray): Pair<String, ByteArray>? {
        if (rawBytes.isEmpty()) return null
        val rawStr = try { String(rawBytes, Charsets.ISO_8859_1) } catch (_: Exception) { "" }
        val boundaryLine = rawStr.lines().firstOrNull { it.contains("MatchboxFrameBoundary") }?.trim() ?: ""
        var boundary = boundaryLine
        if (boundary.startsWith("--")) boundary = boundary.substring(2)
        if (boundary.endsWith("--")) boundary = boundary.substring(0, boundary.length - 2)
        boundary = boundary.trim()

        if (boundary.isNotBlank()) {
            val boundaryBytes = ("--" + boundary).toByteArray(Charsets.ISO_8859_1)
            val parts = splitBytesByDelimiter(rawBytes, boundaryBytes)
            var foundFileName = "picked_desktop_file"

            for (partBytes in parts) {
                if (partBytes.isEmpty()) continue
                val headerSep = findSequence(partBytes, "\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
                val headerSepLen = if (headerSep != -1) 4 else 2
                if (headerSep != -1) {
                    val headerText = String(partBytes.copyOfRange(0, headerSep), Charsets.UTF_8)
                    val bodyBytes = partBytes.copyOfRange(headerSep + headerSepLen, partBytes.size)

                    if (headerText.contains("filename=", ignoreCase = true)) {
                        val m = Regex("""filename\s*=\s*"?([^";]+)"?""", RegexOption.IGNORE_CASE).find(headerText)
                        if (m != null) foundFileName = m.groupValues[1]
                    }

                    if (!headerText.contains("application/json", ignoreCase = true) && bodyBytes.isNotEmpty()) {
                        return Pair(foundFileName, bodyBytes)
                    }
                }
            }
        }
        return null
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

            val blobIdsToUnlink = mutableSetOf<Long>()

            for (json in jsonObjects) {
                listOf("data_blob", "dataBlob", "dataBlobId", "X-Attached-Blob-Id", "X-Blob-Id").forEach { key ->
                    parseBlobId(json.opt(key))?.let { blobIdsToUnlink.add(it) }
                }
                val payloadObj = json.optJSONObject("payload")
                if (payloadObj != null) {
                    listOf("data_blob", "dataBlob", "dataBlobId").forEach { key ->
                        parseBlobId(payloadObj.opt(key))?.let { blobIdsToUnlink.add(it) }
                    }
                }
            }

            val dataBlobRegex = Regex(""""?\b(?:X-Attached-Blob-Id|X-Blob-Id|data_blob|dataBlob)"?\s*[:=]\s*"?(\d+|0x[0-9a-fA-F]+)""", RegexOption.IGNORE_CASE)
            dataBlobRegex.findAll(responseText).forEach { match ->
                parseBlobId(match.groupValues[1])?.let { blobIdsToUnlink.add(it) }
            }

            if (audioBytes == null || audioBytes.isEmpty()) {
                for (blobId in blobIdsToUnlink) {
                    val hexBlobId = formatBlobIdHex(blobId)
                    if (hexBlobId.isBlank()) continue
                    try {
                        val conn = (URL("$baseUrl/xblob/$hexBlobId").openConnection() as HttpURLConnection).apply {
                            requestMethod = "GET"
                            connectTimeout = 5000
                            readTimeout = 10000
                        }
                        if (conn.responseCode in 200..299) {
                            val blobRawBytes = conn.inputStream.readBytes()
                            val extracted = extractAudioBytesFromRawResponse(blobRawBytes) ?: blobRawBytes
                            if (extracted.isNotEmpty()) {
                                audioBytes = extracted
                                break
                            }
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Error fetching xblob $hexBlobId for TTS", e)
                    }
                }
            }

            for (blobId in blobIdsToUnlink) {
                unlinkXBlob(baseUrl, blobId)
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
        targetApp: String = getDefaultRemoteDevice(context),
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

            val rawBytes = inputStream?.readBytes() ?: ByteArray(0)
            val responseText = try { String(rawBytes, Charsets.UTF_8) } catch (_: Exception) { "" }

            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.joinToString("\n---\n") { it.toString(2) }
            } else {
                responseText.ifBlank { "(Empty response body)" }
            }

            Log.i(TAG, "Sent fs.PickFile to $targetApp [$responseCode]: ${rawBytes.size} bytes received")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode): ${rawBytes.size} bytes received\n$formattedDisplay")
                Result(success = true, statusCode = responseCode, responseBody = formattedDisplay, rawBytes = rawBytes)
            } else {
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(success = false, statusCode = responseCode, responseBody = formattedDisplay, errorMessage = "HTTP $responseCode", rawBytes = rawBytes)
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
        blobId: Long,
        name: String,
        type: String,
        size: Long,
        dataType: String,
        data: String,
        targetApp: String = "cool-clips",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/sys/XBlobBroadcast?app=$targetApp"

        val hexBlobId = formatBlobIdHex(blobId)
        val logPrefix = "[XBlobBroadcast -> $targetApp]"
        addLog("$logPrefix Broadcasting blob $hexBlobId (u32: $blobId): $name ($type, $size bytes)")

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
        rawBytes: ByteArray? = null,
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/fs/SaveAs?app=$targetApp"

        val logPrefix = "[fs.SaveAs -> $targetApp]"
        addLog("$logPrefix Saving file: $name ($type, $size bytes)")

        try {
            var bytesToUpload: ByteArray? = rawBytes
            if (bytesToUpload == null && dataType == "base64" && data.isNotBlank()) {
                bytesToUpload = try {
                    Base64.decode(data, Base64.DEFAULT)
                } catch (_: Exception) {
                    try { Base64.decode(data, Base64.NO_WRAP) } catch (_: Exception) { null }
                }
            }

            var dataBlobRef: Any? = null
            if (bytesToUpload != null && bytesToUpload.isNotEmpty()) {
                val uploadedBlobId = uploadXBlob(context, name, type, bytesToUpload)
                if (uploadedBlobId != null) {
                    dataBlobRef = uploadedBlobId
                }
            }

            if (dataBlobRef == null) {
                dataBlobRef = JSONObject().apply {
                    put("name", name)
                    put("type", type)
                    put("size", size)
                    put("_dataType", dataType)
                    put("data", data)
                }
            }

            val jsonBody = JSONObject().apply {
                put("intent", "fs.SaveAs")
                put("app", targetApp)
                put("dataBlob", dataBlobRef)
                put("name", name)
                put("mimeType", type)
                put("size", size)
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

    suspend fun uploadXBlob(
        context: Context,
        name: String,
        type: String,
        inputStream: InputStream,
        size: Long,
        onProgress: ((bytesWritten: Long, totalBytes: Long) -> Unit)? = null,
    ): String? = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/xblob"

        val logPrefix = "[XBlob Upload]"
        addLog("$logPrefix Uploading stream $name ($type, $size bytes)...")

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
                val jsonObjects = extractJsonObjects(responseText)
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
                    addLog("$logPrefix SUCCESS -> Blob ID $blobIdHex")
                    return@withContext blobIdHex
                }
            }
            addLog("$logPrefix FAILED ($responseCode)")
        } catch (e: Exception) {
            Log.e(TAG, "Error uploading XBlob stream to $fullUrl", e)
            addLog("$logPrefix ERROR: ${e.javaClass.simpleName}: ${e.message}")
        }
        return@withContext null
    }

    suspend fun uploadXBlob(
        context: Context,
        name: String,
        type: String,
        rawBytes: ByteArray,
    ): String? = uploadXBlob(context, name, type, rawBytes.inputStream(), rawBytes.size.toLong())

    suspend fun sendSendToIntent(
        context: Context,
        name: String,
        type: String,
        size: Long,
        dataType: String,
        data: String,
        targetApp: String = "cool-clips",
        rawBytes: ByteArray? = null,
        inputStream: InputStream? = null,
        onProgress: ((Long, Long) -> Unit)? = null,
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/fs/SendTo?app=$targetApp"

        val logPrefix = "[fs.SendTo -> $targetApp]"
        addLog("$logPrefix Sending file: $name ($type, $size bytes)")

        try {
            var uploadedBlobId: String? = null
            if (inputStream != null) {
                uploadedBlobId = uploadXBlob(context, name, type, inputStream, size, onProgress)
            } else {
                var bytesToUpload: ByteArray? = rawBytes
                if (bytesToUpload == null && dataType == "base64" && data.isNotBlank()) {
                    bytesToUpload = try {
                        Base64.decode(data, Base64.DEFAULT)
                    } catch (_: Exception) {
                        try { Base64.decode(data, Base64.NO_WRAP) } catch (_: Exception) { null }
                    }
                }

                if (bytesToUpload != null && bytesToUpload.isNotEmpty()) {
                    uploadedBlobId = uploadXBlob(context, name, type, bytesToUpload.inputStream(), bytesToUpload.size.toLong(), onProgress)
                }
            }

            val jsonBody = JSONObject().apply {
                put("intent", "fs.SendTo")
                put("app", targetApp)
                put("name", name)
                put("mimeType", type)
                put("size", size)
                if (uploadedBlobId == null) {
                    put("dataBlob", JSONObject().apply {
                        put("name", name)
                        put("type", type)
                        put("size", size)
                        put("_dataType", dataType)
                        put("data", data)
                    })
                }
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
                if (uploadedBlobId != null) {
                    setRequestProperty("X-Attached-Blob-Id", uploadedBlobId)
                }
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

            Log.i(TAG, "Sent fs.SendTo to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode):\n$formattedDisplay")
                Result(
                    success = true,
                    statusCode = responseCode,
                    responseBody = formattedDisplay,
                )
            } else {
                sendSaveAsIntent(context, name, type, size, dataType, data, targetApp)
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending fs.SendTo to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            sendSaveAsIntent(context, name, type, size, dataType, data, targetApp)
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

    suspend fun sendMediaPlayIntent(
        context: Context,
        name: String,
        type: String,
        size: Long,
        dataType: String,
        data: String,
        targetApp: String,
        title: String = name,
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/media/Play?app=$targetApp"

        val logPrefix = "[media.Play -> $targetApp]"
        addLog("$logPrefix Dispatching media stream: $name ($type, $size bytes)")

        try {
            val blobJson = JSONObject().apply {
                put("name", name)
                put("type", type)
                put("size", size)
                put("_dataType", dataType)
                put("data", data)
            }

            val jsonBody = JSONObject().apply {
                put("intent", "media.Play")
                put("app", targetApp)
                put("title", title)
                put("url", if (dataType == "url") data else "")
                put("mimeType", type)
                put("blob", blobJson)
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 15000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
                setRequestProperty("Accept", "application/json")
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

            Log.i(TAG, "Sent media.Play to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode):\n$formattedDisplay")
                Result(success = true, statusCode = responseCode, responseBody = formattedDisplay)
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
            val errorMsg = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending media.Play to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorMsg")
            Result(success = false, errorMessage = errorMsg)
        }
    }

    suspend fun sendMediaTranscodeIntent(
        context: Context,
        name: String,
        type: String,
        size: Long,
        dataType: String,
        data: String,
        targetAccept: String,
        targetApp: String = "cool-transcoder",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/media/Transcode?app=$targetApp"

        val logPrefix = "[media.Transcode -> $targetApp]"
        addLog("$logPrefix Requesting transcode for $name ($type) targeting '$targetAccept'")

        try {
            val blobJson = JSONObject().apply {
                put("name", name)
                put("type", type)
                put("size", size)
                put("_dataType", dataType)
                put("data", data)
            }

            val jsonBody = JSONObject().apply {
                put("intent", "media.Transcode")
                put("app", targetApp)
                put("accept", targetAccept)
                put("targetCodecs", targetAccept)
                put("title", name)
                put("url", if (dataType == "url") data else "")
                put("blob", blobJson)
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 15000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
                setRequestProperty("Accept", "application/json")
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

            Log.i(TAG, "Sent media.Transcode to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode):\n$formattedDisplay")
                Result(success = true, statusCode = responseCode, responseBody = formattedDisplay)
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
            val errorMsg = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending media.Transcode to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorMsg")
            Result(success = false, errorMessage = errorMsg)
        }
    }

    suspend fun sendBridgePeerIntent(
        context: Context,
        peerHost: String,
        targetApp: String = "cool-http-bridge",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/bridge/Peer?app=$targetApp"

        val logPrefix = "[bridge.Peer -> $peerHost]"
        addLog("$logPrefix Peering bridge with $peerHost")

        try {
            val jsonBody = JSONObject().apply {
                put("intent", "bridge.Peer")
                put("host", peerHost)
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 15000
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
            val responseText = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8")).readText()

            Log.i(TAG, "Sent bridge.Peer [$responseCode]: $responseText")
            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode): $responseText")
                Result(success = true, statusCode = responseCode, responseBody = responseText)
            } else {
                addLog("$logPrefix ERROR ($responseCode): $responseText")
                Result(success = false, statusCode = responseCode, responseBody = responseText, errorMessage = "HTTP $responseCode: $responseText")
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending bridge.Peer to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(success = false, errorMessage = errorDetail)
        }
    }

    suspend fun sendBridgeUnpeerIntent(
        context: Context,
        peerHost: String,
        targetApp: String = "cool-http-bridge",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/bridge/Unpeer?app=$targetApp"

        val logPrefix = "[bridge.Unpeer -> $peerHost]"
        addLog("$logPrefix Unpeering bridge with $peerHost")

        try {
            val jsonBody = JSONObject().apply {
                put("intent", "bridge.Unpeer")
                put("host", peerHost)
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 15000
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
            val responseText = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8")).readText()

            Log.i(TAG, "Sent bridge.Unpeer [$responseCode]: $responseText")
            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode): $responseText")
                Result(success = true, statusCode = responseCode, responseBody = responseText)
            } else {
                addLog("$logPrefix ERROR ($responseCode): $responseText")
                Result(success = false, statusCode = responseCode, responseBody = responseText, errorMessage = "HTTP $responseCode: $responseText")
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending bridge.Unpeer to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(success = false, errorMessage = errorDetail)
        }
    }
}
