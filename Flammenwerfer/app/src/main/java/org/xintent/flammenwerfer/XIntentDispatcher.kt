package org.xintent.flammenwerfer

import android.content.Context
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.WebSocket
import org.json.JSONObject
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.core.XIntentLogManager
import org.xintent.flammenwerfer.net.XIntentTransport
import org.xintent.flammenwerfer.protocol.XIntentProtocolParser
import org.xintent.flammenwerfer.storage.XIntentBlobClient
import java.io.InputStream
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

object XIntentDispatcher {
    private const val TAG = "XIntentDispatcher"

    private data class HttpRawResponse(
        val code: Int,
        val rawBytes: ByteArray,
    ) {
        val isSuccess: Boolean get() = code in 200..299
        val text: String get() = try { String(rawBytes, Charsets.UTF_8) } catch (_: Exception) { "" }
    }

    private fun executeJsonPost(
        fullUrl: String,
        payload: JSONObject,
        connectTimeoutMs: Int = 10000,
        readTimeoutMs: Int = 15000,
        attachedBlobId: String? = null,
    ): HttpRawResponse {
        val connection = (URL(fullUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("X-Forwarded-By", "flammenwerfer")
            if (attachedBlobId != null) {
                setRequestProperty("X-Attached-Blob-Id", attachedBlobId)
            }
        }
        OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
            writer.write(payload.toString())
            writer.flush()
        }
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val bytes = (stream ?: "".byteInputStream()).readBytes()
        return HttpRawResponse(code, bytes)
    }

    fun handleWebSocketRawBytes(webSocket: WebSocket, rawBytes: ByteArray, context: Context) {
        XIntentTransport.resetWsIdleTimer(context) { XIntentTransport.disconnectWebSocket() }
        val (jsonList, _) = XIntentProtocolParser.parseMultipartRawBytes(rawBytes)
        for (json in jsonList) {
            dispatchIncomingWebSocketFrame(webSocket, json, context)
        }
    }

    private fun dispatchIncomingWebSocketFrame(webSocket: WebSocket, json: JSONObject, context: Context) {
        val intentName = json.optString("intent", json.optString("event", ""))
        val txId = json.optInt("txId", 0)
        when (intentName) {
            "xaudio.PlaySoundBlob", "XAudioPlay", "xaudio.Play" ->
                if (XIntentPreferences.isLocalAudioEnabled(context)) handleWsAudioPlay(webSocket, json, txId)
            "xaudio.ControlStream", "XAudioControl" ->
                if (XIntentPreferences.isLocalAudioEnabled(context)) handleWsAudioControl(webSocket, json, txId)
            "ui.TextToSpeech" ->
                if (XIntentPreferences.isLocalTtsEnabled(context)) handleWsTts(webSocket, json, txId)
        }
    }

    private fun handleWsAudioPlay(webSocket: WebSocket, json: JSONObject, txId: Int) {
        val rawRes = CardsActivity.instance?.triggerLocalAudioPlay(json.toString()) ?: "{}"
        val resObj = JSONObject(rawRes).apply {
            put("event", "XAudioPlayResponseV0")
            put("status", 200)
            if (txId != 0) put("txId", txId)
        }
        webSocket.send(resObj.toString())
        XIntentLogManager.addLog("[XAudioSink 🔊] Sent XAudioPlayResponseV0 for txId $txId over WebSocket")
    }

    private fun handleWsAudioControl(webSocket: WebSocket, json: JSONObject, txId: Int) {
        val resJsonStr = CardsActivity.instance?.triggerLocalAudioControl(json.toString()) ?: JSONObject().apply {
            put("event", "XAudioControlResponseV0")
            put("status", 200)
            if (txId != 0) put("txId", txId)
        }.toString()
        webSocket.send(resJsonStr)
        XIntentLogManager.addLog("[XAudioSink 🔊] Sent XAudioControlResponseV0 for txId $txId over WebSocket")
    }

    private fun handleWsTts(webSocket: WebSocket, json: JSONObject, txId: Int) {
        val fallback = JSONObject().apply {
            put("intent", "ui.TextToSpeechResponse")
            put("status", "ok")
            put("message", "Speaking via local Android TTS")
            put("disposition", "final")
        }.toString()
        val rawRes = CardsActivity.instance?.triggerLocalTts(json.toString()) ?: fallback
        val resObj = JSONObject(rawRes).apply {
            put("event", "ui.TextToSpeechResponse")
            put("controlWord", 2)
            if (txId != 0) put("txId", txId)
        }
        webSocket.send(resObj.toString())
        XIntentLogManager.addLog("[ui.TextToSpeech 🗣️] Sent ui.TextToSpeechResponse for txId $txId over WebSocket")
    }

    suspend fun sendTextProcessIntent(
        context: Context,
        text: String,
        targetApp: String = "cool-clips",
        canReplace: Boolean = false,
        namespace: String = "ui",
        action: String = "TextProcess",
    ): XIntentClient.Result = withContext(Dispatchers.IO) {
        val fullUrl = "${XIntentPreferences.getServerUrl(context)}/intent/$namespace/$action?app=$targetApp"
        val logPrefix = "[$namespace.$action -> $targetApp]"
        XIntentLogManager.addLog("$logPrefix Processing text: \"$text\"")

        try {
            val payload = JSONObject().apply {
                put("intent", "$namespace.$action")
                put("app", targetApp)
                put("text", text)
                put("canReplace", canReplace)
                put("controlWord", 1)
            }
            val res = executeJsonPost(fullUrl, payload, connectTimeoutMs = 10000, readTimeoutMs = 15000)
            val replacement = XIntentCatalogParser.extractReplacementText(res.text) ?: ""
            if (res.isSuccess) {
                XIntentLogManager.addLog("$logPrefix SUCCESS -> Processed text")
                return@withContext XIntentClient.Result(success = true, responseBody = res.text, replacementText = replacement)
            }
            XIntentLogManager.addLog("$logPrefix FAILED (${res.code})")
            XIntentClient.Result(success = false, errorMessage = "HTTP ${res.code}")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending $namespace.$action to $fullUrl", e)
            XIntentLogManager.addLog("$logPrefix ERROR: ${e.message}")
            XIntentClient.Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

    suspend fun sendBridgePeerIntent(context: Context, peerHost: String): XIntentClient.Result =
        sendBridgeControlIntent(context, "Peer", peerHost, "Peering", "Peered")

    suspend fun sendBridgeUnpeerIntent(context: Context, peerHost: String): XIntentClient.Result =
        sendBridgeControlIntent(context, "Unpeer", peerHost, "Unpeering", "Unpeered")

    private suspend fun sendBridgeControlIntent(
        context: Context,
        action: String,
        peerHost: String,
        ingVerb: String,
        edVerb: String,
    ): XIntentClient.Result = withContext(Dispatchers.IO) {
        val fullUrl = "${XIntentPreferences.getServerUrl(context)}/intent/bridge/$action"
        val logPrefix = "[bridge.$action]"
        XIntentLogManager.addLog("$logPrefix $ingVerb with host $peerHost...")

        try {
            val payload = JSONObject().apply {
                put("event", "bridge.$action")
                put("peerHost", peerHost)
            }
            val res = executeJsonPost(fullUrl, payload, connectTimeoutMs = 5000, readTimeoutMs = 5000)
            if (res.isSuccess) {
                XIntentLogManager.addLog("$logPrefix SUCCESS -> $edVerb with $peerHost")
                return@withContext XIntentClient.Result(success = true)
            }
            XIntentLogManager.addLog("$logPrefix FAILED (${res.code})")
            XIntentClient.Result(success = false, errorMessage = "HTTP ${res.code}")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending bridge.$action to $fullUrl", e)
            XIntentLogManager.addLog("$logPrefix ERROR: ${e.message}")
            XIntentClient.Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

    private fun decodeBase64Safely(dataType: String, data: String): ByteArray? {
        if (dataType != "base64" || data.isBlank()) return null
        return try {
            Base64.decode(data, Base64.DEFAULT)
        } catch (_: Exception) {
            try { Base64.decode(data, Base64.NO_WRAP) } catch (_: Exception) { null }
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
    ): XIntentClient.Result = withContext(Dispatchers.IO) {
        val fullUrl = "${XIntentPreferences.getServerUrl(context)}/intent/media/Transcode?app=$targetApp"
        val logPrefix = "[media.Transcode -> $targetApp]"
        XIntentLogManager.addLog("$logPrefix Transcoding $name ($type) for target accept: $targetAccept")

        try {
            val bytesToUpload = decodeBase64Safely(dataType, data)
            val uploadedBlobId = if (bytesToUpload != null && bytesToUpload.isNotEmpty()) {
                XIntentBlobClient.uploadXBlob(context, name, type, bytesToUpload)
            } else null

            val payload = JSONObject().apply {
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
            val res = executeJsonPost(fullUrl, payload, 15000, 30000, uploadedBlobId)
            if (res.isSuccess) {
                XIntentLogManager.addLog("$logPrefix SUCCESS -> Transcode requested")
                return@withContext XIntentClient.Result(success = true, responseBody = res.text)
            }
            XIntentLogManager.addLog("$logPrefix FAILED (${res.code}): ${res.text}")
            XIntentClient.Result(success = false, errorMessage = "HTTP ${res.code}: ${res.text}")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending media.Transcode to $fullUrl", e)
            XIntentLogManager.addLog("$logPrefix ERROR: ${e.message}")
            XIntentClient.Result(success = false, errorMessage = e.message ?: "Network error")
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
    ): XIntentClient.Result = withContext(Dispatchers.IO) {
        val fullUrl = "${XIntentPreferences.getServerUrl(context)}/intent/media/Play?app=$targetApp"
        val logPrefix = "[media.Play -> $targetApp]"
        XIntentLogManager.addLog("$logPrefix Playing media: $title ($type)")

        try {
            val payload = JSONObject().apply {
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
            val res = executeJsonPost(fullUrl, payload, 15000, 30000)
            if (res.isSuccess) {
                XIntentLogManager.addLog("$logPrefix SUCCESS -> Sent to $targetApp")
                return@withContext XIntentClient.Result(success = true)
            }
            XIntentLogManager.addLog("$logPrefix FAILED (${res.code})")
            XIntentClient.Result(success = false, errorMessage = "HTTP ${res.code}")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending media.Play to $fullUrl", e)
            XIntentLogManager.addLog("$logPrefix ERROR: ${e.message}")
            XIntentClient.Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

    suspend fun sendTextToSpeechIntent(
        context: Context,
        text: String,
        voice: String = "default",
        speed: Number = 1.0,
        targetApp: String = "cool-tts",
    ): XIntentClient.Result = withContext(Dispatchers.IO) {
        val fullUrl = "${XIntentPreferences.getServerUrl(context)}/intent/ui/TextToSpeech?app=$targetApp"
        val logPrefix = "[ui.TextToSpeech -> $targetApp]"
        XIntentLogManager.addLog("$logPrefix Speaking text: \"$text\"")

        try {
            val payload = JSONObject().apply {
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
            val res = executeJsonPost(fullUrl, payload, 10000, 15000)
            val (_, audioBytes) = XIntentProtocolParser.parseMultipartRawBytes(res.rawBytes)
            if (res.isSuccess) {
                XIntentLogManager.addLog("$logPrefix SUCCESS -> TTS processed")
                return@withContext XIntentClient.Result(success = true, rawBytes = audioBytes ?: ByteArray(0))
            }
            XIntentLogManager.addLog("$logPrefix FAILED (${res.code})")
            XIntentClient.Result(success = false, errorMessage = "HTTP ${res.code}")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending ui.TextToSpeech to $fullUrl", e)
            XIntentLogManager.addLog("$logPrefix ERROR: ${e.message}")
            XIntentClient.Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

    private suspend fun resolveSendToBlobId(
        context: Context,
        name: String,
        type: String,
        size: Long,
        dataType: String,
        data: String,
        rawBytes: ByteArray?,
        inputStream: InputStream?,
        onProgress: ((Long, Long) -> Unit)?,
    ): String? {
        if (inputStream != null) {
            return XIntentBlobClient.uploadXBlob(context, name, type, inputStream, size, onProgress)
        }
        val bytes = rawBytes ?: decodeBase64Safely(dataType, data) ?: return null
        if (bytes.isEmpty()) return null
        return XIntentBlobClient.uploadXBlob(context, name, type, bytes.inputStream(), bytes.size.toLong(), onProgress)
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
    ): XIntentClient.Result = withContext(Dispatchers.IO) {
        val fullUrl = "${XIntentPreferences.getServerUrl(context)}/intent/fs/SendTo?app=$targetApp"
        val logPrefix = "[fs.SendTo -> $targetApp]"
        XIntentLogManager.addLog("$logPrefix Sending file: $name ($type, $size bytes)")

        try {
            val uploadedBlobId = resolveSendToBlobId(context, name, type, size, dataType, data, rawBytes, inputStream, onProgress)
            val payload = JSONObject().apply {
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
            val res = executeJsonPost(fullUrl, payload, 15000, 30000, uploadedBlobId)
            if (res.isSuccess) {
                XIntentLogManager.addLog("$logPrefix SUCCESS -> Sent to $targetApp")
                return@withContext XIntentClient.Result(success = true)
            }
            XIntentLogManager.addLog("$logPrefix FAILED (${res.code})")
            XIntentClient.Result(success = false, errorMessage = "HTTP ${res.code}")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending fs.SendTo to $fullUrl", e)
            XIntentLogManager.addLog("$logPrefix ERROR: ${e.message}")
            XIntentClient.Result(success = false, errorMessage = e.message ?: "Network error")
        }
    }

    suspend fun sendPickFileIntent(
        context: Context,
        holdOpenForWrite: Boolean = false,
        targetApp: String = "cool-clips",
    ): XIntentClient.Result = withContext(Dispatchers.IO) {
        val fullUrl = "${XIntentPreferences.getServerUrl(context)}/intent/fs/PickFile?app=$targetApp"
        val logPrefix = "[fs.PickFile -> $targetApp]"
        XIntentLogManager.addLog("$logPrefix Requesting file pick from $targetApp...")

        try {
            val payload = JSONObject().apply {
                put("intent", "fs.PickFile")
                put("app", targetApp)
                put("holdOpenForWrite", holdOpenForWrite)
                put("controlWord", 1)
            }
            val res = executeJsonPost(fullUrl, payload, 10000, 30000)
            if (res.isSuccess) {
                XIntentLogManager.addLog("$logPrefix SUCCESS -> Pick file completed (${res.rawBytes.size} bytes)")
                return@withContext XIntentClient.Result(success = true, responseBody = res.text, rawBytes = res.rawBytes)
            }
            XIntentLogManager.addLog("$logPrefix FAILED (${res.code})")
            XIntentClient.Result(success = false, errorMessage = "HTTP ${res.code}")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending fs.PickFile to $fullUrl", e)
            XIntentLogManager.addLog("$logPrefix ERROR: ${e.message}")
            XIntentClient.Result(success = false, errorMessage = e.message ?: "Network error")
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
        blobIdHex: String = if (blobId > 0) XIntentProtocolParser.formatBlobIdHex(blobId) else "",
        hostName: String = XIntentPreferences.getHostname(context),
        version: Int = 1,
    ): Boolean = withContext(Dispatchers.IO) {
        val fullUrl = "${XIntentPreferences.getServerUrl(context)}/intent/sys/BroadcastXBlob"
        val logPrefix = "[XBlob Broadcast]"
        XIntentLogManager.addLog("$logPrefix Broadcasting version $version of $blobIdHex on host $hostName...")

        try {
            val payload = JSONObject().apply {
                put("intent", "sys.BroadcastXBlob")
                put("blobId", blobIdHex)
                put("hostName", hostName)
                put("version", version)
                putOptIfNotBlank("name", name)
                putOptIfNotBlank("mimeType", type)
                if (size > 0) put("size", size)
                putOptIfNotBlank("dataType", dataType)
                putOptIfNotBlank("data", data)
            }
            val res = executeJsonPost(fullUrl, payload, 5000, 5000)
            if (res.isSuccess) {
                XIntentLogManager.addLog("$logPrefix SUCCESS -> Broadcast registered")
                return@withContext true
            }
            XIntentLogManager.addLog("$logPrefix FAILED (${res.code})")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending XBlob Broadcast to $fullUrl", e)
            XIntentLogManager.addLog("$logPrefix ERROR: ${e.message}")
        }
        false
    }

    private fun JSONObject.putOptIfNotBlank(key: String, value: String) {
        if (value.isNotBlank()) put(key, value)
    }
}
