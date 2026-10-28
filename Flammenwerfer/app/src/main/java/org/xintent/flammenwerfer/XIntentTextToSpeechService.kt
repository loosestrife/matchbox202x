package org.xintent.flammenwerfer

import android.media.AudioFormat
import android.os.Handler
import android.os.Looper
import android.speech.tts.SynthesisCallback
import android.speech.tts.SynthesisRequest
import android.speech.tts.TextToSpeech
import android.speech.tts.TextToSpeechService
import android.util.Base64
import android.util.Log
import android.widget.Toast
import kotlinx.coroutines.runBlocking
import org.xintent.flammenwerfer.config.XIntentPreferences
import java.nio.ByteBuffer
import java.nio.ByteOrder

class XIntentTextToSpeechService : TextToSpeechService() {

    companion object {
        private const val TAG = "XIntentTTS"
    }

    private data class WavInfo(
        val sampleRate: Int = 22050,
        val numChannels: Int = 1,
        val bitsPerSample: Int = 16,
        val audioFormat: Int = 1,
        val pcmOffset: Int = 44,
        val pcmLength: Int = 0,
    )

    override fun onIsLanguageAvailable(lang: String?, country: String?, variant: String?): Int =
        TextToSpeech.LANG_AVAILABLE

    override fun onGetLanguage(): Array<String> = arrayOf("eng", "USA", "")

    override fun onLoadLanguage(lang: String?, country: String?, variant: String?): Int =
        TextToSpeech.LANG_AVAILABLE

    override fun onStop() {
        Log.i(TAG, "TTS synthesis stopped")
    }

    override fun onSynthesizeText(request: SynthesisRequest?, callback: SynthesisCallback?) {
        if (request == null || callback == null) return
        val text = request.charSequenceText?.toString().orEmpty()
        if (text.isBlank()) return

        val speechRate = (request.speechRate / 100.0f).coerceIn(0.5f, 3.0f)
        val targetApp = XIntentPreferences.getTtsTargetApp(applicationContext).ifBlank { "cool-tts" }
        Log.i(TAG, "Synthesizing text via $targetApp: $text")

        runBlocking {
            val result = XIntentDispatcher.sendTextToSpeechIntent(
                context = applicationContext,
                text = text,
                targetApp = targetApp,
                speed = speechRate,
            )
            val wavBytes = resolveSynthesizedWavBytes(result)
            if (result.success && wavBytes != null && wavBytes.isNotEmpty()) {
                streamWavBytesToCallback(wavBytes, callback)
            } else {
                showTtsFailureToast(result)
            }
        }
        callback.done()
    }

    private fun resolveSynthesizedWavBytes(result: XIntentClient.Result): ByteArray? {
        if (result.rawBytes.isNotEmpty()) return result.rawBytes
        if (result.replacementText.isBlank()) return null
        return try {
            Base64.decode(result.replacementText, Base64.DEFAULT)
        } catch (_: Exception) {
            null
        }
    }

    private fun streamWavBytesToCallback(wavBytes: ByteArray, callback: SynthesisCallback) {
        val wav = parseWavHeader(wavBytes)
        val pcm16Bytes = extractPcm16BitAudio(wav, wavBytes)
        val bytesPerFrame = wav.numChannels * 2
        val totalBytes = (pcm16Bytes.size / bytesPerFrame) * bytesPerFrame

        Log.i(TAG, "Streaming $totalBytes bytes of normalized 16-bit PCM data (${wav.sampleRate} Hz, ${wav.numChannels} ch) to Android TTS engine")
        callback.start(wav.sampleRate, AudioFormat.ENCODING_PCM_16BIT, wav.numChannels)
        if (totalBytes <= 0) return

        val frameAlignedMaxBuffer = (callback.maxBufferSize.coerceAtLeast(1024) / bytesPerFrame) * bytesPerFrame
        var offset = 0
        var remaining = totalBytes
        while (remaining > 0) {
            val chunkSize = minOf(remaining, frameAlignedMaxBuffer)
            val status = callback.audioAvailable(pcm16Bytes, offset, chunkSize)
            if (status != TextToSpeech.SUCCESS) {
                Log.e(TAG, "SynthesisCallback.audioAvailable failed with status $status at offset $offset")
                break
            }
            offset += chunkSize
            remaining -= chunkSize
        }
    }

    private fun showTtsFailureToast(result: XIntentClient.Result) {
        val errorDetails = if (!result.success && result.errorMessage.isNotBlank()) ": ${result.errorMessage}" else ""
        Handler(Looper.getMainLooper()).post {
            Toast.makeText(applicationContext, "XIntent TTS failed to connect to bridge$errorDetails", Toast.LENGTH_LONG).show()
        }
    }

    private fun extractPcm16BitAudio(wav: WavInfo, bytes: ByteArray): ByteArray {
        val startOffset = wav.pcmOffset
        if (startOffset < 0 || startOffset >= bytes.size) return ByteArray(0)
        val length = wav.pcmLength.coerceAtMost(bytes.size - startOffset)
        if (length <= 0) return ByteArray(0)

        return when {
            wav.bitsPerSample == 16 && (wav.audioFormat == 1 || wav.audioFormat == 0) ->
                extractAligned16BitSlice(bytes, startOffset, length, wav.numChannels * 2)
            wav.bitsPerSample == 8 -> convert8BitTo16BitPcm(bytes, startOffset, length)
            wav.bitsPerSample == 24 -> convert24BitTo16BitPcm(bytes, startOffset, length)
            wav.bitsPerSample == 32 || wav.audioFormat == 3 -> convert32BitFloatTo16BitPcm(bytes, startOffset, length)
            else -> extractAligned16BitSlice(bytes, startOffset, length, wav.numChannels * 2)
        }
    }

    private fun extractAligned16BitSlice(bytes: ByteArray, startOffset: Int, length: Int, bytesPerFrame: Int): ByteArray {
        val alignedOffset = if (startOffset % 2 != 0) startOffset + 1 else startOffset
        val alignedLength = ((length - (alignedOffset - startOffset)) / bytesPerFrame) * bytesPerFrame
        if (alignedLength <= 0) return ByteArray(0)
        return bytes.copyOfRange(alignedOffset, alignedOffset + alignedLength)
    }

    private fun convert8BitTo16BitPcm(bytes: ByteArray, startOffset: Int, sampleCount: Int): ByteArray {
        val out = ByteArray(sampleCount * 2)
        for (i in 0 until sampleCount) {
            val unsignedVal = bytes[startOffset + i].toInt() and 0xFF
            val pcm16 = (unsignedVal - 128) * 256
            out[i * 2] = (pcm16 and 0xFF).toByte()
            out[i * 2 + 1] = ((pcm16 shr 8) and 0xFF).toByte()
        }
        return out
    }

    private fun convert24BitTo16BitPcm(bytes: ByteArray, startOffset: Int, length: Int): ByteArray {
        val sampleCount = length / 3
        val out = ByteArray(sampleCount * 2)
        for (i in 0 until sampleCount) {
            val idx = startOffset + (i * 3)
            if (idx + 2 < bytes.size) {
                out[i * 2] = bytes[idx + 1]
                out[i * 2 + 1] = bytes[idx + 2]
            }
        }
        return out
    }

    private fun convert32BitFloatTo16BitPcm(bytes: ByteArray, startOffset: Int, length: Int): ByteArray {
        val sampleCount = length / 4
        val out = ByteArray(sampleCount * 2)
        val buffer = ByteBuffer.wrap(bytes, startOffset, sampleCount * 4).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until sampleCount) {
            val pcm16 = (buffer.float * 32767.0f).toInt().coerceIn(-32768, 32767)
            out[i * 2] = (pcm16 and 0xFF).toByte()
            out[i * 2 + 1] = ((pcm16 shr 8) and 0xFF).toByte()
        }
        return out
    }

    private fun readLe16(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xFF) or ((bytes[offset + 1].toInt() and 0xFF) shl 8)

    private fun readLe32(bytes: ByteArray, offset: Int): Int =
        readLe16(bytes, offset) or (readLe16(bytes, offset + 2) shl 16)

    private fun isRiffWaveHeader(bytes: ByteArray): Boolean =
        bytes.size >= 12 &&
            String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" &&
            String(bytes, 8, 4, Charsets.US_ASCII) == "WAVE"

    private fun findFallbackDataChunk(bytes: ByteArray): Pair<Int, Int>? {
        for (i in 0 until bytes.size - 8) {
            if (String(bytes, i, 4, Charsets.US_ASCII) == "data") {
                val pcmOffset = i + 8
                val subchunk2Size = readLe32(bytes, i + 4)
                val maxRemaining = (bytes.size - pcmOffset).coerceAtLeast(0)
                val pcmLen = if (subchunk2Size in 1..maxRemaining) subchunk2Size else maxRemaining
                return Pair(pcmOffset, pcmLen)
            }
        }
        return null
    }

    private fun parseWavHeader(bytes: ByteArray): WavInfo {
        var info = WavInfo(pcmLength = (bytes.size - 44).coerceAtLeast(0))
        var foundData = false

        if (isRiffWaveHeader(bytes)) {
            var offset = 12
            while (offset + 8 <= bytes.size) {
                val chunkId = String(bytes, offset, 4, Charsets.US_ASCII)
                val chunkSize = readLe32(bytes, offset + 4)
                if (chunkId == "fmt " && offset + 24 <= bytes.size) {
                    info = info.copy(
                        audioFormat = readLe16(bytes, offset + 8).coerceAtLeast(1),
                        numChannels = readLe16(bytes, offset + 10).coerceAtLeast(1),
                        sampleRate = readLe32(bytes, offset + 12),
                        bitsPerSample = readLe16(bytes, offset + 22).coerceAtLeast(8),
                    )
                } else if (chunkId == "data") {
                    val pcmOff = offset + 8
                    val maxRem = (bytes.size - pcmOff).coerceAtLeast(0)
                    info = info.copy(
                        pcmOffset = pcmOff,
                        pcmLength = if (chunkSize in 1..maxRem) chunkSize else maxRem,
                    )
                    foundData = true
                    break
                }
                offset += 8 + chunkSize + (chunkSize and 1)
            }
        }

        if (!foundData) {
            findFallbackDataChunk(bytes)?.let { (off, len) ->
                info = info.copy(pcmOffset = off, pcmLength = len)
            }
        }

        val clampedOffset = info.pcmOffset.coerceIn(0, bytes.size)
        return info.copy(
            sampleRate = info.sampleRate.coerceIn(8000, 192000),
            numChannels = info.numChannels.coerceIn(1, 2),
            pcmOffset = clampedOffset,
            pcmLength = info.pcmLength.coerceIn(0, (bytes.size - clampedOffset).coerceAtLeast(0)),
        )
    }
}
