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
import java.nio.ByteBuffer
import java.nio.ByteOrder

class XIntentTextToSpeechService : TextToSpeechService() {

    companion object {
        private const val TAG = "XIntentTTS"
    }

    private data class WavInfo(
        val sampleRate: Int,
        val numChannels: Int,
        val bitsPerSample: Int,
        val audioFormat: Int,
        val pcmOffset: Int,
        val pcmLength: Int
    )

    override fun onIsLanguageAvailable(lang: String?, country: String?, variant: String?): Int {
        return TextToSpeech.LANG_AVAILABLE
    }

    override fun onGetLanguage(): Array<String> {
        return arrayOf("eng", "USA", "")
    }

    override fun onLoadLanguage(lang: String?, country: String?, variant: String?): Int {
        return TextToSpeech.LANG_AVAILABLE
    }

    override fun onStop() {
        Log.i(TAG, "TTS synthesis stopped")
    }

    override fun onSynthesizeText(request: SynthesisRequest?, callback: SynthesisCallback?) {
        if (request == null || callback == null) return

        val text = request.charSequenceText?.toString() ?: ""
        if (text.isBlank()) return

        val speechRate = (request.speechRate / 100.0f).coerceIn(0.5f, 3.0f)
        val targetApp = XIntentClient.getTtsTargetApp(applicationContext).ifBlank { "cool-tts" }

        Log.i(TAG, "Synthesizing text via $targetApp: $text")

        runBlocking {
            val result = XIntentClient.sendTextToSpeechIntent(
                context = applicationContext,
                text = text,
                targetApp = targetApp,
                speed = speechRate,
            )

            val wavBytes = if (result.rawBytes.isNotEmpty()) {
                result.rawBytes
            } else if (!result.replacementText.isNullOrBlank()) {
                try { Base64.decode(result.replacementText, Base64.DEFAULT) } catch (_: Exception) { null }
            } else null

            if (result.success && wavBytes != null && wavBytes.isNotEmpty()) {
                val wav = parseWavHeader(wavBytes)
                val pcm16Bytes = extractPcm16BitAudio(wav, wavBytes)
                val bytesPerFrame = wav.numChannels * 2
                val totalBytes = (pcm16Bytes.size / bytesPerFrame) * bytesPerFrame

                Log.i(TAG, "Streaming $totalBytes bytes of normalized 16-bit PCM data (${wav.sampleRate} Hz, ${wav.numChannels} ch) to Android TTS engine")

                callback.start(wav.sampleRate, AudioFormat.ENCODING_PCM_16BIT, wav.numChannels)

                if (totalBytes > 0) {
                    val maxBuffer = callback.maxBufferSize.coerceAtLeast(1024)
                    val frameAlignedMaxBuffer = (maxBuffer / bytesPerFrame) * bytesPerFrame
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
            } else {
                val errorDetails = if (!result.success && result.errorMessage.isNotBlank()) {
                    ": ${result.errorMessage}"
                } else {
                    ""
                }
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(
                        applicationContext,
                        "XIntent TTS failed to connect to bridge$errorDetails",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }

        callback.done()
    }

    private fun extractPcm16BitAudio(wav: WavInfo, bytes: ByteArray): ByteArray {
        val startOffset = wav.pcmOffset
        var length = wav.pcmLength

        if (startOffset < 0 || startOffset >= bytes.size) return ByteArray(0)
        if (startOffset + length > bytes.size) {
            length = bytes.size - startOffset
        }
        if (length <= 0) return ByteArray(0)

        // Case 1: Already 16-bit PCM
        if (wav.bitsPerSample == 16 && (wav.audioFormat == 1 || wav.audioFormat == 0)) {
            val bytesPerFrame = wav.numChannels * 2
            var alignedOffset = startOffset
            if (alignedOffset % 2 != 0) alignedOffset += 1
            var alignedLength = length - (alignedOffset - startOffset)
            alignedLength = (alignedLength / bytesPerFrame) * bytesPerFrame
            if (alignedLength <= 0) return ByteArray(0)
            return bytes.copyOfRange(alignedOffset, alignedOffset + alignedLength)
        }

        // Case 2: 8-bit unsigned PCM
        if (wav.bitsPerSample == 8) {
            val sampleCount = length
            val out = ByteArray(sampleCount * 2)
            for (i in 0 until sampleCount) {
                val unsignedVal = bytes[startOffset + i].toInt() and 0xFF
                val pcm16 = (unsignedVal - 128) * 256
                out[i * 2] = (pcm16 and 0xFF).toByte()
                out[i * 2 + 1] = ((pcm16 shr 8) and 0xFF).toByte()
            }
            return out
        }

        // Case 3: 24-bit signed PCM
        if (wav.bitsPerSample == 24) {
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

        // Case 4: 32-bit float PCM
        if (wav.bitsPerSample == 32 || wav.audioFormat == 3) {
            val sampleCount = length / 4
            val out = ByteArray(sampleCount * 2)
            val buffer = ByteBuffer.wrap(bytes, startOffset, sampleCount * 4).order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until sampleCount) {
                val floatVal = buffer.float
                val pcm16 = (floatVal * 32767.0f).toInt().coerceIn(-32768, 32767)
                out[i * 2] = (pcm16 and 0xFF).toByte()
                out[i * 2 + 1] = ((pcm16 shr 8) and 0xFF).toByte()
            }
            return out
        }

        // Fallback: 16-bit aligned slice
        val bytesPerFrame = wav.numChannels * 2
        val alignedLength = (length / bytesPerFrame) * bytesPerFrame
        return bytes.copyOfRange(startOffset, startOffset + alignedLength)
    }

    private fun parseWavHeader(bytes: ByteArray): WavInfo {
        var sampleRate = 22050
        var numChannels = 1
        var bitsPerSample = 16
        var audioFormat = 1
        var pcmOffset = 44
        var pcmLength = bytes.size - 44
        var foundData = false

        if (bytes.size >= 12 &&
            bytes[0] == 'R'.code.toByte() && bytes[1] == 'I'.code.toByte() &&
            bytes[2] == 'F'.code.toByte() && bytes[3] == 'F'.code.toByte() &&
            bytes[8] == 'W'.code.toByte() && bytes[9] == 'A'.code.toByte() &&
            bytes[10] == 'V'.code.toByte() && bytes[11] == 'E'.code.toByte()
        ) {
            var offset = 12
            while (offset + 8 <= bytes.size) {
                val chunkId = String(bytes, offset, 4, Charsets.US_ASCII)
                val chunkSize = (bytes[offset + 4].toInt() and 0xFF) or
                        ((bytes[offset + 5].toInt() and 0xFF) shl 8) or
                        ((bytes[offset + 6].toInt() and 0xFF) shl 16) or
                        ((bytes[offset + 7].toInt() and 0xFF) shl 24)

                if (chunkId == "fmt " && offset + 24 <= bytes.size) {
                    audioFormat = ((bytes[offset + 8].toInt() and 0xFF) or ((bytes[offset + 9].toInt() and 0xFF) shl 8)).coerceAtLeast(1)
                    numChannels = ((bytes[offset + 10].toInt() and 0xFF) or ((bytes[offset + 11].toInt() and 0xFF) shl 8)).coerceAtLeast(1)
                    sampleRate = (bytes[offset + 12].toInt() and 0xFF) or
                            ((bytes[offset + 13].toInt() and 0xFF) shl 8) or
                            ((bytes[offset + 14].toInt() and 0xFF) shl 16) or
                            ((bytes[offset + 15].toInt() and 0xFF) shl 24)
                    bitsPerSample = ((bytes[offset + 22].toInt() and 0xFF) or ((bytes[offset + 23].toInt() and 0xFF) shl 8)).coerceAtLeast(8)
                } else if (chunkId == "data") {
                    pcmOffset = offset + 8
                    pcmLength = if (chunkSize in 1..(bytes.size - pcmOffset)) chunkSize else (bytes.size - pcmOffset).coerceAtLeast(0)
                    foundData = true
                    break
                }

                offset += 8 + chunkSize
                if (chunkSize % 2 != 0) offset += 1
            }
        }

        if (!foundData) {
            for (i in 0 until bytes.size - 8) {
                if (bytes[i] == 'd'.code.toByte() && bytes[i + 1] == 'a'.code.toByte() &&
                    bytes[i + 2] == 't'.code.toByte() && bytes[i + 3] == 'a'.code.toByte()
                ) {
                    pcmOffset = i + 8
                    val subchunk2Size = (bytes[i + 4].toInt() and 0xFF) or
                            ((bytes[i + 5].toInt() and 0xFF) shl 8) or
                            ((bytes[i + 6].toInt() and 0xFF) shl 16) or
                            ((bytes[i + 7].toInt() and 0xFF) shl 24)
                    pcmLength = if (subchunk2Size in 1..(bytes.size - pcmOffset)) subchunk2Size else (bytes.size - pcmOffset).coerceAtLeast(0)
                    break
                }
            }
        }

        return WavInfo(
            sampleRate = sampleRate.coerceIn(8000, 192000),
            numChannels = numChannels.coerceIn(1, 2),
            bitsPerSample = bitsPerSample,
            audioFormat = audioFormat,
            pcmOffset = pcmOffset.coerceIn(0, bytes.size),
            pcmLength = pcmLength.coerceIn(0, (bytes.size - pcmOffset).coerceAtLeast(0))
        )
    }
}
