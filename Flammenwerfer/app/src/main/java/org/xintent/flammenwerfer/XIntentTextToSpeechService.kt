package org.xintent.flammenwerfer

import android.media.AudioFormat
import android.speech.tts.SynthesisCallback
import android.speech.tts.SynthesisRequest
import android.speech.tts.TextToSpeech
import android.speech.tts.TextToSpeechService
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.runBlocking

class XIntentTextToSpeechService : TextToSpeechService() {

    companion object {
        private const val TAG = "XIntentTTS"
    }

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
        val targetApp = XIntentClient.getTargetApp(applicationContext, 1).ifBlank { "cool-tts" }

        Log.i(TAG, "Synthesizing text via $targetApp: $text")

        runBlocking {
            val result = XIntentClient.sendTextToSpeechIntent(
                context = applicationContext,
                text = text,
                targetApp = targetApp,
                speed = speechRate,
            )

            if (result.success && result.replacementText != null) {
                val wavBytes = Base64.decode(result.replacementText, Base64.DEFAULT)
                if (wavBytes.isNotEmpty()) {
                    val sampleRate = extractWavSampleRate(wavBytes)
                    val numChannels = extractWavChannels(wavBytes)
                    val pcmOffset = findWavDataOffset(wavBytes) ?: 44
                    val pcmLength = (wavBytes.size - pcmOffset).coerceAtLeast(0)

                    Log.i(TAG, "Streaming $pcmLength bytes of PCM data ($sampleRate Hz, $numChannels ch, maxBuffer ${callback.maxBufferSize}) to Android TTS engine")

                    callback.start(sampleRate, AudioFormat.ENCODING_PCM_16BIT, numChannels)
                    if (pcmLength > 0) {
                        val maxBuffer = callback.maxBufferSize.coerceAtLeast(1024)
                        var offset = pcmOffset
                        var remaining = pcmLength

                        while (remaining > 0) {
                            val chunkSize = minOf(remaining, maxBuffer)
                            val status = callback.audioAvailable(wavBytes, offset, chunkSize)
                            if (status != TextToSpeech.SUCCESS) {
                                Log.e(TAG, "SynthesisCallback.audioAvailable failed with status $status at offset $offset")
                                break
                            }
                            offset += chunkSize
                            remaining -= chunkSize
                        }
                    }
                }
            }
        }

        callback.done()
    }

    private fun extractWavSampleRate(bytes: ByteArray): Int {
        return if (bytes.size >= 28) {
            (bytes[24].toInt() and 0xFF) or
            ((bytes[25].toInt() and 0xFF) shl 8) or
            ((bytes[26].toInt() and 0xFF) shl 16) or
            ((bytes[27].toInt() and 0xFF) shl 24)
        } else {
            22050
        }
    }

    private fun extractWavChannels(bytes: ByteArray): Int {
        return if (bytes.size >= 24) {
            (bytes[22].toInt() and 0xFF) or ((bytes[23].toInt() and 0xFF) shl 8)
        } else {
            1
        }
    }

    private fun findWavDataOffset(bytes: ByteArray): Int? {
        for (i in 0 until bytes.size - 4) {
            if (bytes[i] == 'd'.code.toByte() &&
                bytes[i + 1] == 'a'.code.toByte() &&
                bytes[i + 2] == 't'.code.toByte() &&
                bytes[i + 3] == 'a'.code.toByte()
            ) {
                return i + 8
            }
        }
        return null
    }
}
