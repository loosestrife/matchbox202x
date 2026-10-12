package org.xintent.flammenwerfer

import android.webkit.JavascriptInterface
import kotlinx.coroutines.runBlocking

class XIntentJSBridge(private val activity: CardsActivity) {

    @Suppress("unused")
    @JavascriptInterface
    fun getDefaultRemoteDevice(): String {
        return XIntentClient.getDefaultRemoteDevice(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun getAudioRoutingMode(): String {
        return XIntentClient.getAudioRoutingMode(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun getTtsRoutingMode(): String {
        return XIntentClient.getTtsRoutingMode(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun getClipboardRoutingMode(): String {
        return XIntentClient.getClipboardRoutingMode(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun getFsRoutingMode(): String {
        return XIntentClient.getFsRoutingMode(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun isLocalAudioEnabled(): Boolean {
        return XIntentClient.isLocalAudioEnabled(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalAudioPlay(jsonPayload: String): String {
        return activity.triggerLocalAudioPlay(jsonPayload)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalPrefetch(jsonPayload: String): String {
        return activity.triggerLocalPrefetch(jsonPayload)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalAudioControl(jsonPayload: String): String {
        return activity.triggerLocalAudioControl(jsonPayload)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun isLocalTtsEnabled(): Boolean {
        return XIntentClient.isLocalTtsEnabled(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalTts(jsonPayload: String): String {
        return activity.triggerLocalTts(jsonPayload)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun isLocalClipboardEnabled(): Boolean {
        return XIntentClient.isLocalClipboardEnabled(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalCopy(jsonPayload: String): String {
        return activity.triggerLocalCopy(jsonPayload)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalPaste(): String {
        return activity.triggerLocalPaste()
    }

    @Suppress("unused")
    @JavascriptInterface
    fun isLocalFsEnabled(): Boolean {
        return XIntentClient.isLocalFsEnabled(activity.applicationContext)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalPickFile(jsonPayload: String): String {
        return activity.triggerLocalPickFile(jsonPayload)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalSaveAs(jsonPayload: String): String {
        return activity.triggerLocalSaveAs(jsonPayload)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun logMessage(msg: String) {
        XIntentClient.addLog(msg)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun fetchApiTagsJson(): String {
        return runBlocking {
            val res = XIntentClient.fetchApiTags(activity.applicationContext)
            if (res.success) res.responseBody else "{}"
        }
    }

    @Suppress("unused")
    @JavascriptInterface
    fun postIntent(namespace: String, action: String, appName: String, jsonPayload: String): String {
        return runBlocking {
            val res = XIntentClient.sendTextProcessIntent(
                context = activity.applicationContext,
                text = jsonPayload,
                targetApp = appName,
                namespace = namespace,
                action = action,
            )
            res.responseBody
        }
    }
}
