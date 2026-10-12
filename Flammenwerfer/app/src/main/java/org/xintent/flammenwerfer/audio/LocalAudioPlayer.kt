package org.xintent.flammenwerfer.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import org.xintent.flammenwerfer.XIntentClient
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors

data class LocalAudioChunk(
    val seqnum: Int,
    val streamId: Int,
    val cookie: String,
    val tempAudioFile: File,
    val sizeBytes: Int,
    val keepAlive: Boolean = false,
)

class LocalAudioPlayer(
    private val context: Context,
    private val onDispatchJsResponse: (JSONObject) -> Unit,
) {

    private val localAudioQueue = ConcurrentLinkedQueue<LocalAudioChunk>()
    private var isLocalAudioPlaying = false
    private var localMediaPlayer: MediaPlayer? = null
    private val localBlobCache = ConcurrentHashMap<String, File>()

    fun triggerLocalPrefetch(jsonPayload: String): String {
        return try {
            val json = JSONObject(jsonPayload)
            val sampleId = json.optString("sample")
                .ifBlank { json.optString("blobId", json.optString("blob", "")) }

            if (sampleId.isNotBlank() && !localBlobCache.containsKey(sampleId)) {
                val serverUrl = XIntentClient.getServerUrl(context)
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
                                val tempFile = File.createTempFile("flammen_prefetch_", ".wav", context.cacheDir)
                                FileOutputStream(tempFile).use { it.write(audioBytes) }
                                localBlobCache[sampleId] = tempFile
                                XIntentClient.addLog("[xaudio.PrefetchSoundBlob] Prefetched blob $sampleId (${audioBytes.size} bytes)")
                            }
                        }
                    } catch (e: Exception) {
                        Log.e("LocalAudioPlayer", "Error prefetching xblob $sampleId", e)
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

            val sampleId = json.optString("sample")
                .ifBlank { json.optString("blobId", json.optString("blob", "")) }

            XIntentClient.addLog("[xaudio.PlaySoundBlob] Received XAudioPlay intent: cookie=$cookie, seq=$seqnum, sample=$sampleId")

            var audioBytes: ByteArray? = null
            if (json.has("data") && json.optString("_dataType") == "base64") {
                audioBytes = Base64.decode(json.getString("data"), Base64.DEFAULT)
            } else if (json.has("blob")) {
                val blobObj = json.optJSONObject("blob")
                if (blobObj != null && blobObj.optString("_dataType") == "base64") {
                    audioBytes = Base64.decode(blobObj.getString("data"), Base64.DEFAULT)
                }
            }

            var tempAudioFile: File? = if (sampleId.isNotBlank()) localBlobCache.remove(sampleId) else null

            if (tempAudioFile == null && audioBytes == null && sampleId.isNotBlank()) {
                val serverUrl = XIntentClient.getServerUrl(context)
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
                    Log.e("LocalAudioPlayer", "Error fetching xblob $sampleId from $blobUrl", e)
                }
            }

            if (tempAudioFile == null && audioBytes != null && audioBytes.isNotEmpty()) {
                tempAudioFile = File.createTempFile("flammen_audio_", ".wav", context.cacheDir)
                FileOutputStream(tempAudioFile).use { fos ->
                    fos.write(audioBytes)
                }
            }

            if (tempAudioFile != null && tempAudioFile.exists()) {
                val fileSize = tempAudioFile.length().toInt()
                val headersObj = json.optJSONObject("headers")
                val connHeader = headersObj?.optString("Connection")
                    ?: headersObj?.optString("connection")
                    ?: json.optString("Connection")
                    ?: json.optString("connection")
                val keepAlive = connHeader.equals("keep-alive", ignoreCase = true) || json.optBoolean("keepAlive", false)

                val chunk = LocalAudioChunk(seqnum, streamId, cookie, tempAudioFile, fileSize, keepAlive)
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
                XIntentClient.addLog("[xaudio.PlaySoundBlob ⚠️] Received XAudioPlay seq #$seqnum for sample '$sampleId', but no audio bytes or cached xblob were found")
                JSONObject().apply {
                    put("status", "ok")
                    put("message", "XAudioPlay received (no audio data)")
                    put("cookie", cookie)
                    put("seqnum", seqnum)
                }.toString()
            }
        } catch (e: Exception) {
            XIntentClient.addLog("[xaudio.PlaySoundBlob ❌] Error handling XAudioPlay: ${e.message}")
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
                stop()
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

    fun stop() {
        localAudioQueue.clear()
        localMediaPlayer?.stop()
        localMediaPlayer?.release()
        localMediaPlayer = null
        isLocalAudioPlaying = false
        XIntentClient.addLog("[xaudio.ControlStream] Stopped phone speaker audio playback & cleared queue")
    }

    fun release() {
        stop()
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
                setWakeMode(context.applicationContext, PowerManager.PARTIAL_WAKE_LOCK)
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                setDataSource(chunk.tempAudioFile.absolutePath)
                setOnCompletionListener { _ ->
                    XIntentClient.addLog("[xaudio.PlaySoundBlob] Finished playing seq #${chunk.seqnum} on phone speaker")

                    val isQueueEmpty = localAudioQueue.isEmpty()
                    val controlWord = if (isQueueEmpty && !chunk.keepAlive) 2 else 1 // 2 = FIN if queue empty & no keep-alive

                    val responseJson = JSONObject().apply {
                        put("event", "XAudioPlayResponseV0")
                        put("intent", "XAudioPlayResponseV0")
                        put("status", 200)
                        put("cookie", chunk.cookie)
                        put("OutputId", chunk.cookie)
                        put("streamId", chunk.streamId)
                        put("seqnum", chunk.seqnum)
                        put("controlWord", controlWord)
                    }

                    onDispatchJsResponse(responseJson)

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

    private fun extractAudioBytesFromResponse(rawBytes: ByteArray): ByteArray? {
        if (rawBytes.isEmpty()) return null

        if (rawBytes.size >= 4 && rawBytes[0] == 'R'.code.toByte() && rawBytes[1] == 'I'.code.toByte()) {
            return rawBytes
        }

        val sepPos = findSequence(rawBytes, "\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
        if (sepPos != -1) {
            val headerText = try { String(rawBytes.copyOfRange(0, sepPos), Charsets.ISO_8859_1) } catch (_: Exception) { "" }
            if (headerText.contains("Content-Type:", ignoreCase = true) || headerText.contains("Content-Encoding:", ignoreCase = true) || headerText.contains("Content-Transfer-Encoding:", ignoreCase = true)) {
                val bodyBytes = rawBytes.copyOfRange(sepPos + 4, rawBytes.size)
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
}
