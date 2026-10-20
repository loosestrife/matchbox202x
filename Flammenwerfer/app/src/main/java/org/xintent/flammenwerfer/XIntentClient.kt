package org.xintent.flammenwerfer

import android.content.Context
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import org.json.JSONObject
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.core.XIntentLogManager
import org.xintent.flammenwerfer.net.XIntentTransport
import org.xintent.flammenwerfer.protocol.XIntentProtocolParser
import org.xintent.flammenwerfer.storage.XIntentBlobClient
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

object XIntentClient {
    private const val TAG = "XIntentClient"

    const val DEFAULT_SERVER_URL = XIntentPreferences.DEFAULT_SERVER_URL
    const val DEFAULT_HOSTNAME = XIntentPreferences.DEFAULT_HOSTNAME
    const val DEFAULT_UDP_PORT = XIntentPreferences.DEFAULT_UDP_PORT
    const val DEFAULT_REMOTE_DEVICE = XIntentPreferences.DEFAULT_REMOTE_DEVICE

    const val FLAMMENWERFER_MANIFEST = """[app]
id = "user-phone:flammenwerfer"

[intents]
"ui.Copy" = true
"ui.Paste" = true
"ui.TextToSpeech" = true
"fs.PickFile" = true
"fs.SendTo" = true
"fs.SaveAs" = true

[XAudioSink]
name = "user-phone:flammenwerfer"
"""

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

    val okHttpClient: OkHttpClient
        get() = XIntentTransport.okHttpClient

    val webSocketState: WebSocketState
        get() = when (XIntentTransport.webSocketState) {
            XIntentTransport.WebSocketState.DISCONNECTED -> WebSocketState.DISCONNECTED
            XIntentTransport.WebSocketState.CONNECTING -> WebSocketState.CONNECTING
            XIntentTransport.WebSocketState.CONNECTED -> WebSocketState.CONNECTED
            XIntentTransport.WebSocketState.ERROR -> WebSocketState.ERROR
        }

    val udpState: UdpState
        get() = when (XIntentTransport.udpState) {
            XIntentTransport.UdpState.DISCONNECTED -> UdpState.DISCONNECTED
            XIntentTransport.UdpState.LISTENING -> UdpState.LISTENING
            XIntentTransport.UdpState.ERROR -> UdpState.ERROR
        }

    fun addWebSocketStateListener(listener: (WebSocketState) -> Unit) {
        XIntentTransport.addWebSocketStateListener { state ->
            val mapped = when (state) {
                XIntentTransport.WebSocketState.DISCONNECTED -> WebSocketState.DISCONNECTED
                XIntentTransport.WebSocketState.CONNECTING -> WebSocketState.CONNECTING
                XIntentTransport.WebSocketState.CONNECTED -> WebSocketState.CONNECTED
                XIntentTransport.WebSocketState.ERROR -> WebSocketState.ERROR
            }
            listener(mapped)
        }
    }

    fun removeWebSocketStateListener(listener: (WebSocketState) -> Unit) {
        // Safe no-op or state removal
    }

    fun addUdpStateListener(listener: (UdpState) -> Unit) {
        XIntentTransport.addUdpStateListener { state ->
            val mapped = when (state) {
                XIntentTransport.UdpState.DISCONNECTED -> UdpState.DISCONNECTED
                XIntentTransport.UdpState.LISTENING -> UdpState.LISTENING
                XIntentTransport.UdpState.ERROR -> UdpState.ERROR
            }
            listener(mapped)
        }
    }

    fun removeUdpStateListener(listener: (UdpState) -> Unit) {
        // Safe no-op or state removal
    }

    fun getUdpPort(context: Context): Int = XIntentPreferences.getUdpPort(context)

    fun setUdpPort(context: Context, port: Int) {
        XIntentPreferences.setUdpPort(context, port)
        startUdpWakeListener(context)
    }

    fun startUdpWakeListener(context: Context) =
        XIntentTransport.startUdpWakeListener(context) { connectWebSocket(it) }

    fun stopUdpWakeListener() = XIntentTransport.stopUdpWakeListener()

    fun connectWebSocket(context: Context) =
        XIntentTransport.connectWebSocket(context) { ws, bytes, ctx ->
            handleWebSocketRawBytes(ws, bytes, ctx)
        }

    fun disconnectWebSocket(context: Context? = null) =
        XIntentTransport.disconnectWebSocket(context)

    fun sendBridgeAdvertise(context: Context, webSocket: WebSocket) =
        XIntentTransport.sendBridgeAdvertise(context, webSocket)

    fun sendSysAdvertise(context: Context, webSocket: WebSocket) =
        sendBridgeAdvertise(context, webSocket)

    fun sendBridgeDeadvertise(context: Context, webSocket: WebSocket) =
        XIntentTransport.sendBridgeDeadvertise(context, webSocket)

    fun sendSysDeadvertise(context: Context, webSocket: WebSocket) =
        sendBridgeDeadvertise(context, webSocket)

    fun handleWebSocketRawBytes(webSocket: WebSocket, rawBytes: ByteArray, context: Context) {
        XIntentTransport.resetWsIdleTimer(context) { disconnectWebSocket() }
        val (jsonList, _) = parseMultipartRawBytes(rawBytes)
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
            } else if (intentName == "ui.TextToSpeech") {
                if (isLocalTtsEnabled(context)) {
                    val resJsonStr = CardsActivity.instance?.triggerLocalTts(json.toString()) ?: JSONObject().apply {
                        put("event", "ui.TextToSpeechResponse")
                        put("intent", "ui.TextToSpeechResponse")
                        put("status", "ok")
                        put("message", "Speaking via local Android TTS")
                        put("disposition", "final")
                        put("controlWord", 2)
                        if (txId != 0) put("txId", txId)
                    }.toString()

                    val resObj = JSONObject(resJsonStr).apply {
                        put("event", "ui.TextToSpeechResponse")
                        if (txId != 0) put("txId", txId)
                        put("controlWord", 2)
                    }
                    webSocket.send(resObj.toString())
                    addLog("[ui.TextToSpeech 🗣️] Sent ui.TextToSpeechResponse for txId $txId over WebSocket")
                }
            }
        }
    }

    // Preferences Delegations
    fun getHostname(context: Context): String = XIntentPreferences.getHostname(context)
    fun setHostname(context: Context, hostname: String) = XIntentPreferences.setHostname(context, hostname)
    fun getAdvertisedName(context: Context): String = XIntentPreferences.getAdvertisedName(context)
    fun getManifest(context: Context): String = XIntentPreferences.getManifest(context)
    fun getDefaultRemoteDevice(context: Context): String = XIntentPreferences.getDefaultRemoteDevice(context)
    fun setDefaultRemoteDevice(context: Context, device: String) = XIntentPreferences.setDefaultRemoteDevice(context, device)
    fun getAudioRoutingMode(context: Context): String = XIntentPreferences.getAudioRoutingMode(context)
    fun setAudioRoutingMode(context: Context, mode: String) = XIntentPreferences.setAudioRoutingMode(context, mode)
    fun getTtsRoutingMode(context: Context): String = XIntentPreferences.getTtsRoutingMode(context)
    fun setTtsRoutingMode(context: Context, mode: String) = XIntentPreferences.setTtsRoutingMode(context, mode)
    fun getClipboardRoutingMode(context: Context): String = XIntentPreferences.getClipboardRoutingMode(context)
    fun setClipboardRoutingMode(context: Context, mode: String) = XIntentPreferences.setClipboardRoutingMode(context, mode)
    fun getFsRoutingMode(context: Context): String = XIntentPreferences.getFsRoutingMode(context)
    fun setFsRoutingMode(context: Context, mode: String) = XIntentPreferences.setFsRoutingMode(context, mode)

    fun isLocalAudioEnabled(context: Context): Boolean = XIntentPreferences.isLocalAudioEnabled(context)
    fun setLocalAudioEnabled(context: Context, enabled: Boolean) = XIntentPreferences.setLocalAudioEnabled(context, enabled)
    fun isLocalTtsEnabled(context: Context): Boolean = XIntentPreferences.isLocalTtsEnabled(context)
    fun setLocalTtsEnabled(context: Context, enabled: Boolean) = XIntentPreferences.setLocalTtsEnabled(context, enabled)
    fun isLocalClipboardEnabled(context: Context): Boolean = XIntentPreferences.isLocalClipboardEnabled(context)
    fun setLocalClipboardEnabled(context: Context, enabled: Boolean) = XIntentPreferences.setLocalClipboardEnabled(context, enabled)
    fun isLocalFsEnabled(context: Context): Boolean = XIntentPreferences.isLocalFsEnabled(context)
    fun setLocalFsEnabled(context: Context, enabled: Boolean) = XIntentPreferences.setLocalFsEnabled(context, enabled)

    fun getServerUrl(context: Context): String = XIntentPreferences.getServerUrl(context)
    fun setServerUrl(context: Context, url: String) = XIntentPreferences.setServerUrl(context, url)
    fun getTargetApp(context: Context, actionIndex: Int): String = XIntentPreferences.getTargetApp(context, actionIndex)
    fun setTargetApp(context: Context, actionIndex: Int, appName: String) = XIntentPreferences.setTargetApp(context, actionIndex, appName)

    // Log Delegations
    fun getLogHistory(): String = XIntentLogManager.getLogHistory()
    fun addLog(entry: String) = XIntentLogManager.addLog(entry)
    fun addLogListener(listener: () -> Unit) = XIntentLogManager.addLogListener(listener)
    fun removeLogListener(listener: () -> Unit) = XIntentLogManager.removeLogListener(listener)

    // Protocol Parser Delegations
    fun parseBlobId(value: Any?): Long? = XIntentProtocolParser.parseBlobId(value)
    fun formatBlobIdHex(blobId: Long): String = XIntentProtocolParser.formatBlobIdHex(blobId)
    fun extractJsonObjects(text: String): List<JSONObject> = XIntentProtocolParser.extractJsonObjects(text)
    fun trimWavBinaryBytes(bytes: ByteArray): ByteArray = XIntentProtocolParser.trimWavBinaryBytes(bytes)
    fun extractAudioBytesFromRawResponse(rawBytes: ByteArray): ByteArray? = XIntentProtocolParser.extractAudioBytesFromRawResponse(rawBytes)
    fun parseMultipartRawBytes(rawBytes: ByteArray): Pair<List<JSONObject>, ByteArray?> = XIntentProtocolParser.parseMultipartRawBytes(rawBytes)
    fun extractFileFromPickFileResponse(rawBytes: ByteArray): Pair<String, ByteArray>? = XIntentProtocolParser.extractFileFromPickFileResponse(rawBytes)

    fun extractReplacementText(responseBody: String): String? {
        val jsonObjects = extractJsonObjects(responseBody)
        if (jsonObjects.isEmpty()) return null
        val json = jsonObjects.first()
        return when {
            json.has("text") -> json.optString("text")
            json.has("replacementText") -> json.optString("replacementText")
            json.has("replacement") -> json.optString("replacement")
            else -> null
        }
    }

    // Storage Delegations
    fun unlinkXBlob(baseUrl: String, blobId: Long) = XIntentBlobClient.unlinkXBlob(baseUrl, blobId)
    suspend fun uploadXBlob(
        context: Context,
        name: String,
        type: String,
        inputStream: InputStream,
        size: Long,
        onProgress: ((bytesWritten: Long, totalBytes: Long) -> Unit)? = null,
    ): String? = XIntentBlobClient.uploadXBlob(context, name, type, inputStream, size, onProgress)

    suspend fun uploadXBlob(
        context: Context,
        name: String,
        type: String,
        rawBytes: ByteArray,
    ): String? = XIntentBlobClient.uploadXBlob(context, name, type, rawBytes)

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
                    )
                )
            }
        }
        return appCards
    }

    data class SendToTarget(
        val appId: String,
        val name: String,
        val description: String,
    )

    fun parseSendToTargets(tagsJsonResponse: String): List<SendToTarget> {
        val targets = mutableListOf<SendToTarget>()
        val jsonObjects = extractJsonObjects(tagsJsonResponse)
        if (jsonObjects.isNotEmpty()) {
            val rootJson = jsonObjects.first()
            if (rootJson.has("apps")) {
                val appsJson = rootJson.getJSONObject("apps")
                val keys = appsJson.keys()
                while (keys.hasNext()) {
                    val appKey = keys.next()
                    val appObj = appsJson.getJSONObject(appKey)
                    val intentsObj = appObj.optJSONObject("intents")
                    if (intentsObj != null && (intentsObj.has("fs.SendTo") || intentsObj.has("ui.Copy") || intentsObj.has("ui.Paste"))) {
                        val friendlyName = appObj.optString("name", appKey)
                        val desc = appObj.optString("description", "Remote Intent Receiver")
                        targets.add(SendToTarget(appKey, friendlyName, desc))
                    }
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
        val description: String,
        val accept: String,
    )

    fun parseMediaPlayTargets(tagsJsonResponse: String): List<MediaPlayTarget> {
        val targets = mutableListOf<MediaPlayTarget>()
        val jsonObjects = extractJsonObjects(tagsJsonResponse)
        if (jsonObjects.isNotEmpty()) {
            val rootJson = jsonObjects.first()
            if (rootJson.has("apps")) {
                val appsJson = rootJson.getJSONObject("apps")
                val keys = appsJson.keys()
                while (keys.hasNext()) {
                    val appKey = keys.next()
                    val appObj = appsJson.getJSONObject(appKey)
                    val intentsObj = appObj.optJSONObject("intents")
                    if (intentsObj != null && intentsObj.has("media.Play")) {
                        val playObj = intentsObj.optJSONObject("media.Play")
                        val acceptStr = playObj?.optString("Accept", playObj.optString("accept", "*/*")) ?: "*/*"
                        val friendlyName = appObj.optString("name", appKey)
                        val desc = appObj.optString("description", "Remote Media Renderer")
                        targets.add(
                            MediaPlayTarget(
                                appId = appKey,
                                name = friendlyName,
                                description = desc,
                                accept = acceptStr,
                            )
                        )
                    }
                }
            }
        }
        return targets
    }

    data class Result(
        val success: Boolean,
        val statusCode: Int = 200,
        val errorMessage: String = "",
        val responseBody: String = "",
        val rawBytes: ByteArray = ByteArray(0),
        val replacementText: String = "",
    )

    suspend fun fetchApiTags(context: Context): Result = fetchRemoteTagsJson(context).let {
        if (it != null) Result(success = true, responseBody = it) else Result(success = false, errorMessage = "Network error")
    }

    suspend fun fetchRemoteTagsJson(context: Context): String? = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/api/tags"

        val logPrefix = "[GET /api/tags]"
        addLog("$logPrefix Fetching remote capabilities...")

        try {
            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 5000
                readTimeout = 5000
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val responseText = reader.readText()

            if (responseCode in 200..299 && responseText.isNotBlank()) {
                addLog("$logPrefix SUCCESS -> Fetched capability tags")
                return@withContext responseText
            }
            addLog("$logPrefix FAILED ($responseCode): $responseText")
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching /api/tags from $fullUrl", e)
            addLog("$logPrefix ERROR: ${e.message}")
        }
        return@withContext null
    }

    suspend fun sendTextProcessIntent(
        context: Context,
        text: String,
        targetApp: String = "cool-clips",
        canReplace: Boolean = false,
        namespace: String = "ui",
        action: String = "TextProcess",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/ui/TextProcess?app=$targetApp"

        val logPrefix = "[ui.TextProcess -> $targetApp]"
        addLog("$logPrefix Processing text: \"$text\"")

        try {
            val url = URL(fullUrl)
            val jsonPayload = JSONObject().apply {
                put("intent", "ui.TextProcess")
                put("app", targetApp)
                put("text", text)
                put("canReplace", canReplace)
                put("controlWord", 1)
            }

            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10000
                readTimeout = 15000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonPayload.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream
            val responseText = (inputStream ?: "".byteInputStream()).bufferedReader().use { it.readText() }
            val replacement = extractReplacementText(responseText) ?: ""

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS -> Processed text")
                return@withContext Result(success = true, responseBody = responseText, replacementText = replacement)
            }

            addLog("$logPrefix FAILED ($responseCode)")
            return@withContext Result(success = false, errorMessage = "HTTP $responseCode")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending ui.TextProcess to $fullUrl", e)
            addLog("$logPrefix ERROR: ${e.message}")
            return@withContext Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

    suspend fun sendBridgePeerIntent(
        context: Context,
        peerHost: String,
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/bridge/Peer"

        val logPrefix = "[bridge.Peer]"
        addLog("$logPrefix Peering with host $peerHost...")

        try {
            val url = URL(fullUrl)
            val jsonPayload = JSONObject().apply {
                put("event", "bridge.Peer")
                put("peerHost", peerHost)
            }

            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 5000
                readTimeout = 5000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonPayload.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS -> Peered with $peerHost")
                return@withContext Result(success = true)
            }
            addLog("$logPrefix FAILED ($responseCode)")
            return@withContext Result(success = false, errorMessage = "HTTP $responseCode")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending bridge.Peer to $fullUrl", e)
            addLog("$logPrefix ERROR: ${e.message}")
            return@withContext Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

    suspend fun sendBridgeUnpeerIntent(
        context: Context,
        peerHost: String,
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/bridge/Unpeer"

        val logPrefix = "[bridge.Unpeer]"
        addLog("$logPrefix Unpeering with host $peerHost...")

        try {
            val url = URL(fullUrl)
            val jsonPayload = JSONObject().apply {
                put("event", "bridge.Unpeer")
                put("peerHost", peerHost)
            }

            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 5000
                readTimeout = 5000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonPayload.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS -> Unpeered with $peerHost")
                return@withContext Result(success = true)
            }
            addLog("$logPrefix FAILED ($responseCode)")
            return@withContext Result(success = false, errorMessage = "HTTP $responseCode")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending bridge.Unpeer to $fullUrl", e)
            addLog("$logPrefix ERROR: ${e.message}")
            return@withContext Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

    suspend fun sendMediaTranscodeIntent(
        context: Context,
        name: String,
        type: String,
        size: Long,
        dataType: String,
        data: String,
        targetAccept: String = "*/*",
        targetApp: String = "cool-transcoder",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/media/Transcode?app=$targetApp"

        val logPrefix = "[media.Transcode -> $targetApp]"
        addLog("$logPrefix Transcoding $name ($type) for target accept: $targetAccept")

        try {
            var uploadedBlobId: String? = null
            var bytesToUpload: ByteArray? = null
            if (dataType == "base64" && data.isNotBlank()) {
                bytesToUpload = try {
                    Base64.decode(data, Base64.DEFAULT)
                } catch (_: Exception) {
                    try { Base64.decode(data, Base64.NO_WRAP) } catch (_: Exception) { null }
                }
            }

            if (bytesToUpload != null && bytesToUpload.isNotEmpty()) {
                uploadedBlobId = uploadXBlob(context, name, type, bytesToUpload)
            }

            val jsonPayload = JSONObject().apply {
                put("intent", "media.Transcode")
                put("app", targetApp)
                put("title", name)
                put("type", type)
                put("targetCodecs", targetAccept)
                put("accept", targetAccept)
                if (uploadedBlobId != null) {
                    put("dataBlob", uploadedBlobId)
                } else if (dataType.isNotBlank()) {
                    put("dataType", dataType)
                    put("data", data)
                }
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
                if (uploadedBlobId != null) {
                    setRequestProperty("X-Attached-Blob-Id", uploadedBlobId)
                }
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonPayload.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val responseText = (if (responseCode in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS -> Transcode requested")
                return@withContext Result(success = true, responseBody = responseText)
            }

            addLog("$logPrefix FAILED ($responseCode): $responseText")
            return@withContext Result(success = false, errorMessage = "HTTP $responseCode: $responseText")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending media.Transcode to $fullUrl", e)
            addLog("$logPrefix ERROR: ${e.message}")
            return@withContext Result(success = false, errorMessage = e.message ?: "Network error")
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
        addLog("$logPrefix Playing media: $title ($type)")

        try {
            val jsonPayload = JSONObject().apply {
                put("intent", "media.Play")
                put("app", targetApp)
                put("title", title)
                put("mimeType", type)
                put("size", size)
                if (dataType == "url") {
                    put("url", data)
                } else if (dataType.isNotBlank()) {
                    put("dataType", dataType)
                    put("data", data)
                }
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonPayload.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS -> Sent to $targetApp")
                return@withContext Result(success = true)
            }

            addLog("$logPrefix FAILED ($responseCode)")
            return@withContext Result(success = false, errorMessage = "HTTP $responseCode")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending media.Play to $fullUrl", e)
            addLog("$logPrefix ERROR: ${e.message}")
            return@withContext Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

    suspend fun sendTextToSpeechIntent(
        context: Context,
        text: String,
        voice: String = "default",
        speed: Number = 1.0,
        targetApp: String = "cool-tts",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/ui/TextToSpeech?app=$targetApp"

        val logPrefix = "[ui.TextToSpeech -> $targetApp]"
        addLog("$logPrefix Speaking text: \"$text\"")

        try {
            val url = URL(fullUrl)
            val jsonPayload = JSONObject().apply {
                put("intent", "ui.TextToSpeech")
                put("app", targetApp)
                put("text", text)
                put("voice", voice)
                put("speed", speed)
                put("rate", speed)
                put("speechRate", speed)
                put("Accept", "*")
                put("controlWord", 1)
            }

            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10000
                readTimeout = 15000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonPayload.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream
            val rawBytes = (inputStream ?: "".byteInputStream()).readBytes()
            val audioBytes = extractAudioBytesFromRawResponse(rawBytes)

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS -> TTS processed")
                return@withContext Result(success = true, rawBytes = audioBytes ?: ByteArray(0))
            }

            addLog("$logPrefix FAILED ($responseCode)")
            return@withContext Result(success = false, errorMessage = "HTTP $responseCode")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending ui.TextToSpeech to $fullUrl", e)
            addLog("$logPrefix ERROR: ${e.message}")
            return@withContext Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

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

            val jsonPayload = JSONObject().apply {
                put("intent", "fs.SendTo")
                put("app", targetApp)
                put("name", name)
                put("mimeType", type)
                put("size", size)

                if (uploadedBlobId != null) {
                    put("dataBlob", uploadedBlobId)
                } else if (dataType.isNotBlank()) {
                    put("dataType", dataType)
                    put("data", data)
                }
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
                if (uploadedBlobId != null) {
                    setRequestProperty("X-Attached-Blob-Id", uploadedBlobId)
                }
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonPayload.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS -> Sent to $targetApp")
                return@withContext Result(success = true)
            }

            addLog("$logPrefix FAILED ($responseCode)")
            return@withContext Result(success = false, errorMessage = "HTTP $responseCode")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending fs.SendTo to $fullUrl", e)
            addLog("$logPrefix ERROR: ${e.message}")
            return@withContext Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

    suspend fun sendPickFileIntent(
        context: Context,
        holdOpenForWrite: Boolean = false,
        targetApp: String = "cool-clips",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/fs/PickFile?app=$targetApp"

        val logPrefix = "[fs.PickFile -> $targetApp]"
        addLog("$logPrefix Requesting file pick from $targetApp...")

        try {
            val url = URL(fullUrl)
            val jsonPayload = JSONObject().apply {
                put("intent", "fs.PickFile")
                put("app", targetApp)
                put("holdOpenForWrite", holdOpenForWrite)
                put("controlWord", 1)
            }

            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonPayload.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream
            val rawBytes = (inputStream ?: "".byteInputStream()).readBytes()
            val responseText = try { String(rawBytes, Charsets.UTF_8) } catch (_: Exception) { "" }

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS -> Pick file completed (${rawBytes.size} bytes)")
                return@withContext Result(success = true, responseBody = responseText, rawBytes = rawBytes)
            }
            addLog("$logPrefix FAILED ($responseCode)")
            return@withContext Result(success = false, errorMessage = "HTTP $responseCode")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending fs.PickFile to $fullUrl", e)
            addLog("$logPrefix ERROR: ${e.message}")
            return@withContext Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

    suspend fun sendXBlobBroadcast(
        context: Context,
        blobId: Long = 0L,
        name: String = "",
        type: String = "*/*",
        size: Long = 0L,
        dataType: String = "",
        data: String = "",
        blobIdHex: String = if (blobId > 0) formatBlobIdHex(blobId) else "",
        hostName: String = getHostname(context),
        version: Int = 1,
    ): Boolean = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/sys/BroadcastXBlob"

        val logPrefix = "[XBlob Broadcast]"
        addLog("$logPrefix Broadcasting version $version of $blobIdHex on host $hostName...")

        try {
            val url = URL(fullUrl)
            val jsonPayload = JSONObject().apply {
                put("intent", "sys.BroadcastXBlob")
                put("blobId", blobIdHex)
                put("hostName", hostName)
                put("version", version)
                if (name.isNotBlank()) put("name", name)
                if (type.isNotBlank()) put("mimeType", type)
                if (size > 0) put("size", size)
                if (dataType.isNotBlank()) put("dataType", dataType)
                if (data.isNotBlank()) put("data", data)
            }

            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 5000
                readTimeout = 5000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonPayload.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS -> Broadcast registered")
                return@withContext true
            }
            addLog("$logPrefix FAILED ($responseCode)")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending XBlob Broadcast to $fullUrl", e)
            addLog("$logPrefix ERROR: ${e.message}")
        }
        return@withContext false
    }
}
