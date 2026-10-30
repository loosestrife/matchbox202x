package org.xintent.flammenwerfer

import android.webkit.JavascriptInterface
import kotlinx.coroutines.runBlocking
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.core.XIntentLogManager

class XIntentJSBridge(private val activity: CardsActivity) {

    @Suppress("unused")
    @JavascriptInterface
    fun getDefaultRemoteDevice(): String =
        XIntentPreferences.getDefaultRemoteDevice(activity.applicationContext)

    @Suppress("unused")
    @JavascriptInterface
    fun getAudioRoutingMode(): String =
        XIntentPreferences.getAudioRoutingMode(activity.applicationContext)

    @Suppress("unused")
    @JavascriptInterface
    fun getTtsRoutingMode(): String =
        XIntentPreferences.getTtsRoutingMode(activity.applicationContext)

    @Suppress("unused")
    @JavascriptInterface
    fun getClipboardRoutingMode(): String =
        XIntentPreferences.getClipboardRoutingMode(activity.applicationContext)

    @Suppress("unused")
    @JavascriptInterface
    fun getFsRoutingMode(): String =
        XIntentPreferences.getFsRoutingMode(activity.applicationContext)

    @Suppress("unused")
    @JavascriptInterface
    fun isLocalAudioEnabled(): Boolean =
        XIntentPreferences.isLocalAudioEnabled(activity.applicationContext)

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalAudioPlay(jsonPayload: String): String =
        activity.triggerLocalAudioPlay(jsonPayload)

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalPrefetch(jsonPayload: String): String =
        activity.triggerLocalPrefetch(jsonPayload)

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalAudioControl(jsonPayload: String): String =
        activity.triggerLocalAudioControl(jsonPayload)

    @Suppress("unused")
    @JavascriptInterface
    fun isLocalTtsEnabled(): Boolean =
        XIntentPreferences.isLocalTtsEnabled(activity.applicationContext)

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalTts(jsonPayload: String): String =
        activity.triggerLocalTts(jsonPayload)

    @Suppress("unused")
    @JavascriptInterface
    fun isLocalClipboardEnabled(): Boolean =
        getClipboardRoutingMode() == "doLocalClipboardCapture"

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalCopy(jsonPayload: String): String =
        activity.triggerLocalCopy(jsonPayload)

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalPaste(): String =
        activity.triggerLocalPaste()

    @Suppress("unused")
    @JavascriptInterface
    fun isLocalFsEnabled(): Boolean =
        getFsRoutingMode() == "doLocalFsCapture"

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalPickFile(jsonPayload: String): String =
        activity.triggerLocalPickFile(jsonPayload)

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalSendTo(jsonPayload: String): String =
        activity.triggerLocalSendTo(jsonPayload)

    @Suppress("unused")
    @JavascriptInterface
    fun handleLocalSaveAs(jsonPayload: String): String =
        activity.triggerLocalSendTo(jsonPayload)

    @Suppress("unused")
    @JavascriptInterface
    fun handleLiveMigrate(targetApp: String) {
        activity.triggerLiveMigrate(targetApp)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun onCardMigrated() {
        activity.handleCardMigrated()
    }

    @Suppress("unused")
    @JavascriptInterface
    fun logMessage(msg: String) {
        XIntentLogManager.addLog(msg)
    }

    @Suppress("unused")
    @JavascriptInterface
    fun fetchApiTagsJson(): String = runBlocking {
        val res = XIntentCatalogParser.fetchApiTags(activity.applicationContext)
        if (res.success) res.responseBody else "{}"
    }

    @Suppress("unused")
    @JavascriptInterface
    fun postIntent(namespace: String, action: String, appName: String, jsonPayload: String): String = runBlocking {
        XIntentDispatcher.sendTextProcessIntent(
            context = activity.applicationContext,
            text = jsonPayload,
            targetApp = appName,
            namespace = namespace,
            action = action,
        ).responseBody
    }
}
