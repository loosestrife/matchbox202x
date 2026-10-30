package org.xintent.flammenwerfer

import android.content.Context
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.core.XIntentLogManager
import org.xintent.flammenwerfer.net.XIntentTransport
import org.xintent.flammenwerfer.protocol.XIntentProtocolParser
import org.xintent.flammenwerfer.storage.XIntentBlobClient

object XIntentClient {
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
        ERROR,
    }

    enum class UdpState {
        DISCONNECTED,
        LISTENING,
        ERROR,
    }

    data class AppCardModel(
        val appId: String,
        val appName: String,
        val description: String = "",
        val mainCard: String = "index",
        val cards: List<String> = listOf("index"),
    )

    data class SendToTarget(
        val appId: String,
        val name: String,
        val description: String,
        val accept: String = "*/*",
        val supportsMediaPlay: Boolean = false,
    )

    data class MediaPlayTarget(
        val appId: String,
        val name: String,
        val description: String,
        val accept: String,
    )

    data class Result(
        val success: Boolean,
        val statusCode: Int = 200,
        val errorMessage: String = "",
        val responseBody: String = "",
        val rawBytes: ByteArray = ByteArray(0),
        val replacementText: String = "",
        val attachedBlobId: String = "",
    )

    fun startUdpWakeListener(context: Context) =
        XIntentTransport.startUdpWakeListener(context) { connectWebSocket(it) }

    fun connectWebSocket(context: Context) =
        XIntentTransport.connectWebSocket(context) { ws, bytes, ctx ->
            XIntentDispatcher.handleWebSocketRawBytes(ws, bytes, ctx)
        }

    fun getUdpPort(context: Context): Int = XIntentPreferences.getUdpPort(context)

    fun setUdpPort(context: Context, port: Int) {
        XIntentPreferences.setUdpPort(context, port)
        startUdpWakeListener(context)
    }

    fun getHostname(context: Context): String = XIntentPreferences.getHostname(context)
    fun setHostname(context: Context, hostname: String) = XIntentPreferences.setHostname(context, hostname)
    fun getAdvertisedName(context: Context): String = XIntentPreferences.getAdvertisedName(context)
    fun getManifest(context: Context): String = XIntentPreferences.getManifest(context)

    fun getLogHistory(): String = XIntentLogManager.getLogHistory()
    fun addLog(entry: String) = XIntentLogManager.addLog(entry)

    fun unlinkXBlob(baseUrl: String, blobId: Long) = XIntentBlobClient.unlinkXBlob(baseUrl, blobId)

    fun parseBlobId(value: Any?): Long? = XIntentProtocolParser.parseBlobId(value)
    fun formatBlobIdHex(blobId: Long): String = XIntentProtocolParser.formatBlobIdHex(blobId)
    fun trimWavBinaryBytes(bytes: ByteArray): ByteArray = XIntentProtocolParser.trimWavBinaryBytes(bytes)
    fun extractAudioBytesFromRawResponse(rawBytes: ByteArray): ByteArray? =
        XIntentProtocolParser.extractAudioBytesFromRawResponse(rawBytes)

    fun parseSendToTargets(tagsJsonResponse: String): List<SendToTarget> =
        XIntentCatalogParser.parseSendToTargets(tagsJsonResponse)

    fun parseMediaPlayTargets(tagsJsonResponse: String): List<MediaPlayTarget> =
        XIntentCatalogParser.parseMediaPlayTargets(tagsJsonResponse)
}
