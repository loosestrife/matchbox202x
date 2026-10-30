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

    private fun extractRootObject(tagsJsonResponse: String): JSONObject? =
        XIntentProtocolParser.extractJsonObjects(tagsJsonResponse).firstOrNull()

    private fun extractAppsObject(tagsJsonResponse: String): JSONObject? =
        extractRootObject(tagsJsonResponse)?.optJSONObject("apps")

    private fun parseCardNames(appObj: JSONObject, mainCard: String): List<String> {
        val cardsArray = appObj.optJSONArray("cards") ?: return listOf(mainCard)
        val cardsList = (0 until cardsArray.length()).mapNotNull { cardsArray.optString(it).takeIf(String::isNotBlank) }
        return cardsList.ifEmpty { listOf(mainCard) }
    }

    private fun hasWebCards(appObj: JSONObject): Boolean {
        val hasMainCard = !appObj.isNull("mainCard") && appObj.optString("mainCard", "").isNotBlank()
        val hasCardsArray = (appObj.optJSONArray("cards")?.length() ?: 0) > 0
        return hasMainCard || hasCardsArray
    }

    fun parseAppCards(tagsJsonResponse: String): List<XIntentClient.AppCardModel> {
        val appsJson = extractAppsObject(tagsJsonResponse) ?: return emptyList()
        val appCards = mutableListOf<XIntentClient.AppCardModel>()
        val keys = appsJson.keys()
        while (keys.hasNext()) {
            val appKey = keys.next()
            val appObj = appsJson.optJSONObject(appKey) ?: continue
            if (!hasWebCards(appObj)) continue
            val mainCard = appObj.optString("mainCard", "index").ifBlank { "index" }
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

    private fun extractIntentAppList(intentsJson: JSONObject?, intentName: String): List<String> {
        val arr = intentsJson?.optJSONArray(intentName) ?: return emptyList()
        return (0 until arr.length()).mapNotNull { arr.optString(it).takeIf(String::isNotBlank) }
    }

    private fun supportsSendTo(intentsObj: JSONObject?): Boolean {
        if (intentsObj == null) return false
        return intentsObj.has("fs.SendTo") || intentsObj.has("fs.SaveAs")
    }

    private fun supportsClipboard(intentsObj: JSONObject?): Boolean {
        if (intentsObj == null) return false
        return intentsObj.has("ui.Copy") || intentsObj.has("ui.Paste")
    }

    private fun formatSendToTarget(appId: String, appObj: JSONObject?): XIntentClient.SendToTarget {
        val rawName = appObj?.optString("name", "")?.trim().orEmpty()
        val friendlyName = when {
            rawName.isNotEmpty() && rawName != appId -> rawName
            appId == "cool-clips" -> "Cool Clips (Desktop Clipboard & Files)"
            appId == "user-phone:flammenwerfer" -> "User Phone (Flammenwerfer)"
            appId.startsWith("dlna-") -> "DLNA (${appId.removePrefix("dlna-")})"
            rawName.isNotEmpty() -> rawName
            else -> appId
        }
        val rawDesc = appObj?.optString("description", "")?.trim().orEmpty()
        val desc = when {
            rawDesc.isNotEmpty() -> rawDesc
            appId.startsWith("dlna-") -> "DLNA Media Renderer (fs.SendTo)"
            appId == "cool-clips" -> "Desktop Clipboard & Files (fs.SendTo)"
            else -> "Remote Intent Receiver (fs.SendTo)"
        }
        val intentsObj = appObj?.optJSONObject("intents")
        val playObj = intentsObj?.optJSONObject("media.Play")
        val sendToObj = intentsObj?.optJSONObject("fs.SendTo")
        val acceptStr = playObj?.optString("Accept", playObj.optString("accept", ""))?.takeIf { it.isNotBlank() }
            ?: sendToObj?.optString("Accept", sendToObj.optString("accept", ""))?.takeIf { it.isNotBlank() }
            ?: "*/*"
        val supportsPlay = intentsObj?.has("media.Play") == true || appId.startsWith("dlna-")
        return XIntentClient.SendToTarget(
            appId = appId,
            name = friendlyName,
            description = desc,
            accept = acceptStr,
            supportsMediaPlay = supportsPlay,
        )
    }

    fun parseSendToTargets(tagsJsonResponse: String): List<XIntentClient.SendToTarget> {
        val rootJson = extractRootObject(tagsJsonResponse)
        val intentsJson = rootJson?.optJSONObject("intents")
        val appsJson = rootJson?.optJSONObject("apps")
        val candidateIds = linkedSetOf<String>()

        candidateIds.addAll(extractIntentAppList(intentsJson, "fs.SendTo"))
        candidateIds.addAll(extractIntentAppList(intentsJson, "fs.SaveAs"))

        if (appsJson != null) {
            val keys = appsJson.keys()
            while (keys.hasNext()) {
                val appKey = keys.next()
                val appObj = appsJson.optJSONObject(appKey) ?: continue
                if (supportsSendTo(appObj.optJSONObject("intents"))) {
                    candidateIds.add(appKey)
                }
            }
            if (candidateIds.isEmpty()) {
                val fallbackKeys = appsJson.keys()
                while (fallbackKeys.hasNext()) {
                    val appKey = fallbackKeys.next()
                    val appObj = appsJson.optJSONObject(appKey) ?: continue
                    if (supportsClipboard(appObj.optJSONObject("intents"))) {
                        candidateIds.add(appKey)
                    }
                }
            }
        }

        val targets = candidateIds
            .map { appId -> formatSendToTarget(appId, appsJson?.optJSONObject(appId)) }
            .toMutableList()

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
        val rootJson = extractRootObject(tagsJsonResponse) ?: return emptyList()
        val appsJson = rootJson.optJSONObject("apps")
        val intentsJson = rootJson.optJSONObject("intents")
        val candidateIds = linkedSetOf<String>()

        candidateIds.addAll(extractIntentAppList(intentsJson, "media.Play"))
        if (appsJson != null) {
            val keys = appsJson.keys()
            while (keys.hasNext()) {
                val appKey = keys.next()
                val appObj = appsJson.optJSONObject(appKey) ?: continue
                val intentsObj = appObj.optJSONObject("intents") ?: continue
                if (intentsObj.has("media.Play")) {
                    candidateIds.add(appKey)
                }
            }
        }

        return candidateIds.map { appKey ->
            val appObj = appsJson?.optJSONObject(appKey)
            val playObj = appObj?.optJSONObject("intents")?.optJSONObject("media.Play")
            val acceptStr = playObj?.optString("Accept", playObj.optString("accept", "*/*")) ?: "*/*"
            val rawName = appObj?.optString("name", "")?.trim().orEmpty()
            val friendlyName = when {
                rawName.isNotEmpty() && rawName != appKey -> rawName
                appKey.startsWith("dlna-") -> "DLNA (${appKey.removePrefix("dlna-")})"
                rawName.isNotEmpty() -> rawName
                else -> appKey
            }
            XIntentClient.MediaPlayTarget(
                appId = appKey,
                name = friendlyName,
                description = appObj?.optString("description", "Remote Media Renderer") ?: "Remote Media Renderer",
                accept = acceptStr,
            )
        }
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
