package org.xintent.flammenwerfer.net

import android.content.Context
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
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.core.XIntentLogManager
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

object XIntentTransport {
    private const val TAG = "XIntentClient"

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

    fun createTrustAllOkHttpClient(): OkHttpClient {
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

    val okHttpClient: OkHttpClient by lazy { createTrustAllOkHttpClient() }

    var activeWebSocket: WebSocket? = null
        private set

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

    fun updateWebSocketState(newState: WebSocketState) {
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

    fun updateUdpState(newState: UdpState) {
        udpState = newState
        val copy: List<(UdpState) -> Unit>
        synchronized(udpStateListeners) {
            copy = udpStateListeners.toList()
        }
        copy.forEach { it(newState) }
    }

    private var udpSocket: DatagramSocket? = null
    private var udpJob: Job? = null
    private val udpScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    fun startUdpWakeListener(context: Context, onDemandConnect: (Context) -> Unit) {
        stopUdpWakeListener()
        val port = XIntentPreferences.getUdpPort(context)

        udpJob = udpScope.launch {
            try {
                val socket = DatagramSocket(port)
                udpSocket = socket
                updateUdpState(UdpState.LISTENING)
                XIntentLogManager.addLog("[UDP 🟢] Listening for wake-up pings on UDP port $port...")

                val buffer = ByteArray(1024)
                while (isActive && !socket.isClosed) {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    val msg = String(packet.data, 0, packet.length, Charsets.UTF_8).trim()
                    val senderIp = packet.address?.hostAddress ?: "unknown"

                    XIntentLogManager.addLog("[UDP 🔔] Received wake-up ping from $senderIp:$port: ${msg.ifBlank { "ping" }}")

                    if (webSocketState != WebSocketState.CONNECTED && webSocketState != WebSocketState.CONNECTING) {
                        XIntentLogManager.addLog("[UDP 🔔] Opening WebSocket to bridge on demand...")
                        withContext(Dispatchers.Main) {
                            onDemandConnect(context.applicationContext)
                        }
                    }
                }
            } catch (e: Exception) {
                if (isActive) {
                    Log.e(TAG, "UDP wake listener error", e)
                    updateUdpState(UdpState.ERROR)
                    XIntentLogManager.addLog("[UDP 🔴] Listener error on port $port: ${e.message ?: "Socket error"}")
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

    fun resetWsIdleTimer(context: Context, onDisconnect: () -> Unit) {
        wsIdleJob?.cancel()
        wsIdleJob = CoroutineScope(Dispatchers.IO).launch {
            delay(60000) // 60s idle timeout
            if (webSocketState == WebSocketState.CONNECTED) {
                XIntentLogManager.addLog("[WebSocket ⏱] Idle timeout (60s without traffic). Closing WebSocket to maintain 0 active WebSockets.")
                withContext(Dispatchers.Main) {
                    onDisconnect()
                }
            }
        }
    }

    fun sendBridgeAdvertise(context: Context, webSocket: WebSocket) {
        try {
            val advertisedName = XIntentPreferences.getAdvertisedName(context)
            val manifest = XIntentPreferences.getManifest(context)
            val advertiseJson = JSONObject().apply {
                put("event", "bridge.Advertise")
                put("app", advertisedName)
                put("manifest", manifest)
            }
            webSocket.send(advertiseJson.toString())
            XIntentLogManager.addLog("[bridge.Advertise] Advertised $advertisedName capabilities (ui.Copy, ui.Paste, ui.TextToSpeech, fs.PickFile, fs.SaveAs, XAudioNode)")
            Log.i(TAG, "Sent bridge.Advertise over WebSocket for $advertisedName")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending bridge.Advertise", e)
            XIntentLogManager.addLog("[bridge.Advertise 🔴] Failed to send advertisement: ${e.message}")
        }
    }

    fun sendBridgeDeadvertise(context: Context, webSocket: WebSocket) {
        try {
            val advertisedName = XIntentPreferences.getAdvertisedName(context)
            val deadvertiseJson = JSONObject().apply {
                put("event", "bridge.Deadvertise")
                put("app", advertisedName)
            }
            webSocket.send(deadvertiseJson.toString())
            XIntentLogManager.addLog("[bridge.Deadvertise] Sent deadvertise for $advertisedName")
            Log.i(TAG, "Sent bridge.Deadvertise over WebSocket for $advertisedName")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending bridge.Deadvertise", e)
            XIntentLogManager.addLog("[bridge.Deadvertise 🔴] Failed to send deadvertise: ${e.message}")
        }
    }

    fun connectWebSocket(context: Context, onRawBytesReceived: (WebSocket, ByteArray, Context) -> Unit) {
        if (webSocketState == WebSocketState.CONNECTED || webSocketState == WebSocketState.CONNECTING) {
            return
        }

        val httpUrl = XIntentPreferences.getServerUrl(context)
        val advertisedName = XIntentPreferences.getAdvertisedName(context)
        val wsUrl = httpUrl.replace("http://", "ws://").replace("https://", "wss://") + "/xaudio?XAudioSink=$advertisedName"

        XIntentLogManager.addLog("[WebSocket] Connecting to Remote Intents at $wsUrl...")
        updateWebSocketState(WebSocketState.CONNECTING)

        val request = Request.Builder()
            .url(wsUrl)
            .addHeader("Sec-WebSocket-Protocol", "message-http")
            .build()

        activeWebSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "WebSocket connected to $wsUrl with message-http subprotocol")
                XIntentLogManager.addLog("[WebSocket 🟢] Connected to $wsUrl (message-http)")
                updateWebSocketState(WebSocketState.CONNECTED)
                sendBridgeAdvertise(context, webSocket)
                resetWsIdleTimer(context) { disconnectWebSocket() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                onRawBytesReceived(webSocket, text.toByteArray(Charsets.UTF_8), context)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                onRawBytesReceived(webSocket, bytes.toByteArray(), context)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "WebSocket closing $code: $reason")
                XIntentLogManager.addLog("[WebSocket 🟡] Closing ($code): $reason")
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
                XIntentLogManager.addLog("[WebSocket 🔴] Connection failed: $details")
                updateWebSocketState(WebSocketState.ERROR)
            }
        })
    }

    fun disconnectWebSocket(context: Context? = null) {
        XIntentLogManager.addLog("[WebSocket ⏹] Disconnecting...")
        activeWebSocket?.let { ws ->
            if (context != null) {
                sendBridgeDeadvertise(context, ws)
            }
            ws.close(1000, "User requested disconnect")
        }
        activeWebSocket = null
        updateWebSocketState(WebSocketState.DISCONNECTED)
    }
}
