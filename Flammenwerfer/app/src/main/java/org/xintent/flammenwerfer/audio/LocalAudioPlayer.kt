package org.xintent.flammenwerfer.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.core.XIntentLogManager
import org.xintent.flammenwerfer.protocol.XIntentProtocolParser
import org.xintent.flammenwerfer.storage.XIntentBlobClient
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

    private fun downloadAndUnlinkXBlob(sampleId: Long): ByteArray? {
        val serverUrl = XIntentPreferences.getServerUrl(context)
        val hexSampleId = XIntentProtocolParser.formatBlobIdHex(sampleId)
        val blobUrl = "$serverUrl/xblob/$hexSampleId"
        return try {
            val conn = (URL(blobUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 5000
                readTimeout = 10000
            }
            if (conn.responseCode in 200..299) {
                XIntentProtocolParser.extractAudioBytesFromRawResponse(conn.inputStream.readBytes())
            } else null
        } catch (e: Exception) {
            Log.e("LocalAudioPlayer", "Error fetching xblob $hexSampleId from $blobUrl", e)
            null
        } finally {
            XIntentBlobClient.unlinkXBlob(serverUrl, sampleId)
        }
    }

    private fun writeTempWavFile(prefix: String, audioBytes: ByteArray): File {
        val tempFile = File.createTempFile(prefix, ".wav", context.cacheDir)
        FileOutputStream(tempFile).use { it.write(audioBytes) }
        return tempFile
    }

    fun triggerLocalPrefetch(jsonPayload: String): String {
        return try {
            val json = JSONObject(jsonPayload)
            val rawSample = json.opt("sample") ?: json.opt("blobId") ?: json.opt("blob") ?: ""
            val parsedSampleId = XIntentProtocolParser.parseBlobId(rawSample)
            val sampleIdStr = parsedSampleId?.toString() ?: rawSample.toString()

            if (parsedSampleId != null && !localBlobCache.containsKey(sampleIdStr)) {
                val hexSampleId = XIntentProtocolParser.formatBlobIdHex(parsedSampleId)
                Executors.newSingleThreadExecutor().execute {
                    val audioBytes = downloadAndUnlinkXBlob(parsedSampleId)
                    if (audioBytes != null && audioBytes.isNotEmpty()) {
                        localBlobCache[sampleIdStr] = writeTempWavFile("flammen_prefetch_", audioBytes)
                        XIntentLogManager.addLog("[xaudio.PrefetchSoundBlob] Prefetched blob $hexSampleId (${audioBytes.size} bytes)")
                    }
                }
            }
            JSONObject().put("status", "ok").put("message", "Prefetch started for $sampleIdStr").toString()
        } catch (e: Exception) {
            JSONObject().put("status", "error").put("message", e.message ?: "Failed prefetch").toString()
        }
    }

    private fun extractInlineAudioBytes(json: JSONObject): ByteArray? {
        if (json.has("data") && json.optString("_dataType") == "base64") {
            return Base64.decode(json.getString("data"), Base64.DEFAULT)
        }
        val blobObj = json.optJSONObject("blob")
        if (blobObj != null && blobObj.optString("_dataType") == "base64") {
            return Base64.decode(blobObj.getString("data"), Base64.DEFAULT)
        }
        return null
    }

    private fun resolveAudioTempFile(json: JSONObject, sampleIdStr: String, parsedSampleId: Long?): File? {
        val cached = if (sampleIdStr.isNotBlank()) localBlobCache.remove(sampleIdStr) else null
        if (cached != null && cached.exists()) return cached

        val audioBytes = extractInlineAudioBytes(json)
            ?: parsedSampleId?.let { downloadAndUnlinkXBlob(it) }
        if (audioBytes != null && audioBytes.isNotEmpty()) {
            return writeTempWavFile("flammen_audio_", audioBytes)
        }
        return null
    }

    private fun resolveKeepAliveFlag(json: JSONObject): Boolean {
        val headersObj = json.optJSONObject("headers")
        val connHeader = headersObj?.optString("Connection")
            ?: headersObj?.optString("connection")
            ?: json.optString("Connection")
            ?: json.optString("connection")
        return connHeader.equals("keep-alive", ignoreCase = true) || json.optBoolean("keepAlive", false)
    }

    fun triggerLocalAudioPlay(jsonPayload: String): String {
        return try {
            val json = JSONObject(jsonPayload)
            val cookie = json.optString("cookie").ifBlank { json.optString("Cookie", "default") }
            val seqnum = json.optInt("seqnum", json.optInt("seq", 0))
            val streamId = json.optInt("streamId", json.optInt("stream", 1))
            val rawSample = json.opt("sample") ?: json.opt("blobId") ?: json.opt("blob") ?: ""
            val parsedSampleId = XIntentProtocolParser.parseBlobId(rawSample)
            val sampleIdStr = parsedSampleId?.toString() ?: rawSample.toString()

            XIntentLogManager.addLog("[xaudio.PlaySoundBlob] Received XAudioPlay intent: cookie=$cookie, seq=$seqnum, sample=$sampleIdStr")
            val tempAudioFile = resolveAudioTempFile(json, sampleIdStr, parsedSampleId)

            if (tempAudioFile != null && tempAudioFile.exists()) {
                enqueueAudioChunk(seqnum, streamId, cookie, tempAudioFile, resolveKeepAliveFlag(json))
                JSONObject().put("status", "ok").put("message", "XAudioPlay queued")
                    .put("cookie", cookie).put("seqnum", seqnum).toString()
            } else {
                XIntentLogManager.addLog("[xaudio.PlaySoundBlob ⚠️] Received XAudioPlay seq #$seqnum for sample '$sampleIdStr', but no audio bytes or cached xblob were found")
                JSONObject().put("status", "ok").put("message", "XAudioPlay received (no audio data)")
                    .put("cookie", cookie).put("seqnum", seqnum).toString()
            }
        } catch (e: Exception) {
            XIntentLogManager.addLog("[xaudio.PlaySoundBlob ❌] Error handling XAudioPlay: ${e.message}")
            JSONObject().put("status", "error").put("message", e.message ?: "Failed local audio playback").toString()
        }
    }

    private fun enqueueAudioChunk(seqnum: Int, streamId: Int, cookie: String, file: File, keepAlive: Boolean) {
        val fileSize = file.length().toInt()
        localAudioQueue.add(LocalAudioChunk(seqnum, streamId, cookie, file, fileSize, keepAlive))
        XIntentLogManager.addLog("[xaudio.PlaySoundBlob] Queued phone speaker audio seq #$seqnum ($fileSize bytes). Queue size: ${localAudioQueue.size}")
        synchronized(this) {
            if (!isLocalAudioPlaying) playNextLocalAudioChunk()
        }
    }

    fun triggerLocalAudioControl(jsonPayload: String): String {
        return try {
            val command = JSONObject(jsonPayload).optString("command", "stop")
            if (command == "stop" || command == "pause") stop()
            JSONObject().put("status", "ok").put("command", command).toString()
        } catch (e: Exception) {
            JSONObject().put("status", "error").put("message", e.message ?: "Failed audio control").toString()
        }
    }

    fun stop() {
        localAudioQueue.clear()
        localMediaPlayer?.stop()
        localMediaPlayer?.release()
        localMediaPlayer = null
        isLocalAudioPlaying = false
        XIntentLogManager.addLog("[xaudio.ControlStream] Stopped phone speaker audio playback & cleared queue")
    }

    fun release() = stop()

    private fun playNextLocalAudioChunk() {
        val chunk = localAudioQueue.poll() ?: run {
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
                setOnCompletionListener { onChunkCompleted(chunk) }
                setOnErrorListener { _, what, _ ->
                    XIntentLogManager.addLog("[xaudio.PlaySoundBlob] MediaPlayer error $what on seq #${chunk.seqnum}")
                    try { chunk.tempAudioFile.delete() } catch (_: Exception) {}
                    playNextLocalAudioChunk()
                    true
                }
                prepare()
                start()
            }
            XIntentLogManager.addLog("[xaudio.PlaySoundBlob] Playing seq #${chunk.seqnum} on phone speaker (${chunk.sizeBytes} bytes)")
        } catch (e: Exception) {
            XIntentLogManager.addLog("[xaudio.PlaySoundBlob] Error playing seq #${chunk.seqnum}: ${e.message}")
            try { chunk.tempAudioFile.delete() } catch (_: Exception) {}
            playNextLocalAudioChunk()
        }
    }

    private fun onChunkCompleted(chunk: LocalAudioChunk) {
        XIntentLogManager.addLog("[xaudio.PlaySoundBlob] Finished playing seq #${chunk.seqnum} on phone speaker")
        val controlWord = if (localAudioQueue.isEmpty() && !chunk.keepAlive) 2 else 1
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
}
