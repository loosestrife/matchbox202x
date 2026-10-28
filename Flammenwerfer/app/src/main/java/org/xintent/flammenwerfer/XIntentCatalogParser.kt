package org.xintent.flammenwerfer

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.core.XIntentLogManager
import org.xintent.flammenwerfer.protocol.XIntentProtocolParser
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

object XIntentCatalogParser {
    private const val TAG = "XIntentCatalogParser"

    fun extractReplacementText(responseBody: String): String? {
        val json = XIntentProtocolParser.extractJsonObjects(responseBody).firstOrNull() ?: return null
        return when {
            json.has("text") -> json.optString("text")
            json.has("replacementText") -> json.optString("replacementText")
            json.has("replacement") -> json.optString("replacement")
            else -> null
        }
    }

    private fun extractAppsObject(tagsJsonResponse: String): JSONObject? {
        val rootJson = XIntentProtocolParser.extractJsonObjects(tagsJsonResponse).firstOrNull() ?: return null
        return rootJson.optJSONObject("apps")
    }

    private fun parseCardNames(appObj: JSONObject, mainCard: String): List<String> {
        val cardsArray = appObj.optJSONArray("cards") ?: return listOf(mainCard)
        val cardsList = (0 until cardsArray.length()).mapNotNull { cardsArray.optString(it).takeIf(String::isNotBlank) }
        return cardsList.ifEmpty { listOf(mainCard) }
    }

    fun parseAppCards(tagsJsonResponse: String): List<XIntentClient.AppCardModel> {
        val appsJson = extractAppsObject(tagsJsonResponse) ?: return emptyList()
        val appCards = mutableListOf<XIntentClient.AppCardModel>()
        val keys = appsJson.keys()
        while (keys.hasNext()) {
            val appKey = keys.next()
            val appObj = appsJson.optJSONObject(appKey) ?: continue
            val mainCard = appObj.optString("mainCard", "index")
            appCards.add(
                XIntentClient.AppCardModel(
                    appId = appKey,
                    appName = appObj.optString("name", appKey),
                    description = appObj.optString("description", ""),
                    mainCard = mainCard,
                    cards = parseCardNames(appObj, mainCard),
                )
            )
        }
        return appCards
    }

    private fun supportsSendToOrClipboard(intentsObj: JSONObject?): Boolean {
        if (intentsObj == null) return false
        return intentsObj.has("fs.SendTo") || intentsObj.has("ui.Copy") || intentsObj.has("ui.Paste")
    }

    fun parseSendToTargets(tagsJsonResponse: String): List<XIntentClient.SendToTarget> {
        val targets = mutableListOf<XIntentClient.SendToTarget>()
        val appsJson = extractAppsObject(tagsJsonResponse)
        if (appsJson != null) {
            val keys = appsJson.keys()
            while (keys.hasNext()) {
                val appKey = keys.next()
                val appObj = appsJson.optJSONObject(appKey) ?: continue
                if (supportsSendToOrClipboard(appObj.optJSONObject("intents"))) {
                    val friendlyName = appObj.optString("name", appKey)
                    val desc = appObj.optString("description", "Remote Intent Receiver")
                    targets.add(XIntentClient.SendToTarget(appKey, friendlyName, desc))
                }
            }
        }
        if (targets.isEmpty()) {
            targets.add(
                XIntentClient.SendToTarget(
                    "cool-clips",
                    "Cool Clips (Desktop Clipboard & Files)",
                    "Default Desktop Receiver",
                )
            )
        }
        return targets
    }

    fun parseMediaPlayTargets(tagsJsonResponse: String): List<XIntentClient.MediaPlayTarget> {
        val appsJson = extractAppsObject(tagsJsonResponse) ?: return emptyList()
        val targets = mutableListOf<XIntentClient.MediaPlayTarget>()
        val keys = appsJson.keys()
        while (keys.hasNext()) {
            val appKey = keys.next()
            val appObj = appsJson.optJSONObject(appKey) ?: continue
            val intentsObj = appObj.optJSONObject("intents") ?: continue
            if (!intentsObj.has("media.Play")) continue

            val playObj = intentsObj.optJSONObject("media.Play")
            val acceptStr = playObj?.optString("Accept", playObj.optString("accept", "*/*")) ?: "*/*"
            targets.add(
                XIntentClient.MediaPlayTarget(
                    appId = appKey,
                    name = appObj.optString("name", appKey),
                    description = appObj.optString("description", "Remote Media Renderer"),
                    accept = acceptStr,
                )
            )
        }
        return targets
    }

    suspend fun fetchApiTags(context: Context): XIntentClient.Result {
        val body = fetchRemoteTagsJson(context)
        return if (body != null) {
            XIntentClient.Result(success = true, responseBody = body)
        } else {
            XIntentClient.Result(success = false, errorMessage = "Network error")
        }
    }

    suspend fun fetchRemoteTagsJson(context: Context): String? = withContext(Dispatchers.IO) {
        val fullUrl = "${XIntentPreferences.getServerUrl(context)}/api/tags"
        val logPrefix = "[GET /api/tags]"
        XIntentLogManager.addLog("$logPrefix Fetching remote capabilities...")

        try {
            val connection = (URL(fullUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 5000
                readTimeout = 5000
                setRequestProperty("X-Forwarded-By", "flammenwerfer")
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = BufferedReader(InputStreamReader(stream ?: "".byteInputStream(), "UTF-8")).readText()

            if (code in 200..299 && text.isNotBlank()) {
                XIntentLogManager.addLog("$logPrefix SUCCESS -> Fetched capability tags")
                return@withContext text
            }
            XIntentLogManager.addLog("$logPrefix FAILED ($code): $text")
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching /api/tags from $fullUrl", e)
            XIntentLogManager.addLog("$logPrefix ERROR: ${e.message}")
        }
        null
    }
}
