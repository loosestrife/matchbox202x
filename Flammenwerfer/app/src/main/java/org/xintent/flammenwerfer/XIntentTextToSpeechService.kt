package org.xintent.flammenwerfer

import android.media.AudioFormat
import android.speech.tts.SynthesisCallback
import android.speech.tts.SynthesisRequest
import android.speech.tts.TextToSpeech
import android.speech.tts.TextToSpeechService
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
        val targetApp = XIntentClient.getTargetApp(applicationContext, 1)

        Log.i(TAG, "Synthesizing text via $targetApp: $text")

        val sampleRate = 16000
        callback.start(sampleRate, AudioFormat.ENCODING_PCM_16BIT, 1)

        runBlocking {
            XIntentClient.sendTextToSpeechIntent(
                context = applicationContext,
                text = text,
                targetApp = targetApp,
                speed = speechRate,
            )
        }

        callback.done()
    }
}
