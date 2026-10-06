package org.xintent.flammenwerfer

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object XIntentClient {
    private const val TAG = "XIntentClient"
    private const val PREFS_NAME = "xintent_prefs"
    private const val KEY_SERVER_URL = "server_url"
    const val DEFAULT_SERVER_URL = "http://10.0.2.2:12345"

    private val logListeners = mutableSetOf<() -> Unit>()
    private val logEntries = mutableListOf<String>()

    fun getLogHistory(): String {
        synchronized(logEntries) {
            return if (logEntries.isEmpty()) {
                "No requests dispatched yet."
            } else {
                logEntries.joinToString("\n----------------------------------------\n")
            }
        }
    }

    fun addLog(entry: String) {
        val timeStr = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        val formattedEntry = "[$timeStr] $entry"
        val listenersCopy: List<() -> Unit>
        synchronized(logEntries) {
            logEntries.add(0, formattedEntry)
            if (logEntries.size > 30) {
                logEntries.removeAt(logEntries.size - 1)
            }
        }
        synchronized(logListeners) {
            listenersCopy = logListeners.toList()
        }
        listenersCopy.forEach { it() }
    }

    fun addLogListener(listener: () -> Unit) {
        synchronized(logListeners) {
            logListeners.add(listener)
        }
    }

    fun removeLogListener(listener: () -> Unit) {
        synchronized(logListeners) {
            logListeners.remove(listener)
        }
    }

    fun getServerUrl(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
    }

    fun setServerUrl(context: Context, url: String) {
        val cleanUrl = url.trim().removeSuffix("/")
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_SERVER_URL, cleanUrl).apply()
    }

    fun getTargetApp(context: Context, actionIndex: Int): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val defaultApp = when (actionIndex) {
            1 -> "cool-clips"
            2 -> "cool-bible"
            3 -> "cool-clips"
            else -> "cool-clips"
        }
        return prefs.getString("target_app_action_$actionIndex", defaultApp) ?: defaultApp
    }

    fun setTargetApp(context: Context, actionIndex: Int, appName: String) {
        val cleanApp = appName.trim()
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString("target_app_action_$actionIndex", cleanApp).apply()
    }

    data class AppCardModel(
        val appName: String,
        val description: String = "",
        val mainCard: String = "index",
        val cards: List<String> = listOf("index"),
    )

    fun parseAppCards(tagsJsonResponse: String): List<AppCardModel> {
        val appCards = mutableListOf<AppCardModel>()
        val jsonObjects = extractJsonObjects(tagsJsonResponse)
        if (jsonObjects.isEmpty()) return appCards

        val rootJson = jsonObjects.first()
        if (rootJson.has("apps")) {
            val appsJson = rootJson.getJSONObject("apps")
            val keys = appsJson.keys()
            while (keys.hasNext()) {
                val appKey = keys.next()
                val appObj = appsJson.getJSONObject(appKey)
                val name = appObj.optString("name", appKey)
                val description = appObj.optString("description", "")
                val mainCard = appObj.optString("mainCard", "index")

                val cardsList = mutableListOf<String>()
                if (appObj.has("cards")) {
                    val cardsArray = appObj.getJSONArray("cards")
                    for (i in 0 until cardsArray.length()) {
                        cardsList.add(cardsArray.getString(i))
                    }
                }
                if (cardsList.isEmpty()) {
                    cardsList.add(mainCard)
                }

                appCards.add(
                    AppCardModel(
                        appName = name,
                        description = description,
                        mainCard = mainCard,
                        cards = cardsList,
                    ),
                )
            }
        }
        return appCards
    }

    data class Result(
        val success: Boolean,
        val statusCode: Int = 0,
        val responseBody: String = "",
        val replacementText: String? = null,
        val errorMessage: String? = null,
    )

    fun extractJsonObjects(text: String): List<JSONObject> {
        val results = mutableListOf<JSONObject>()
        var depth = 0
        var start = -1
        for (i in text.indices) {
            when (text[i]) {
                '{' -> {
                    if (depth == 0) start = i
                    depth++
                }
                '}' -> {
                    if (depth > 0) {
                        depth--
                        if (depth == 0) {
                            val candidate = text.substring(start, i + 1)
                            try {
                                results.add(JSONObject(candidate))
                            } catch (_: Exception) {
                            }
                            start = -1
                        }
                    }
                }
            }
        }
        return results
    }

    fun extractReplacementText(responseBody: String): String? {
        val trimmed = responseBody.trim()
        if (trimmed.isBlank()) return null

        val jsonObjects = extractJsonObjects(trimmed)
        if (jsonObjects.isNotEmpty()) {
            for (json in jsonObjects.reversed()) {
                if (json.has("text")) {
                    val textVal = json.getString("text")
                    if (textVal.isNotBlank()) return textVal
                }
                if (json.has("replacementText")) {
                    val textVal = json.getString("replacementText")
                    if (textVal.isNotBlank()) return textVal
                }
                if (json.has("replacement")) {
                    val textVal = json.getString("replacement")
                    if (textVal.isNotBlank()) return textVal
                }
            }
            return null
        }

        return trimmed
    }

    suspend fun fetchApiTags(context: Context): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/api/tags"

        val logPrefix = "[GET /api/tags]"
        addLog("$logPrefix Fetching desktop services & tags...")

        try {
            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8000
                readTimeout = 15000
                setRequestProperty("Accept", "application/json")
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream

            val responseTextBuilder = StringBuilder()
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val buffer = CharArray(1024)
            var bytesRead: Int

            while (reader.read(buffer).also { bytesRead = it } != -1) {
                responseTextBuilder.appendRange(buffer, 0, bytesRead)
                val currentText = responseTextBuilder.toString().trim()
                if (currentText.startsWith("{") && currentText.endsWith("}")) break
            }

            val responseText = responseTextBuilder.toString()
            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.first().toString(2)
            } else {
                responseText.ifBlank { "(Empty tags response)" }
            }

            Log.i(TAG, "Fetched /api/tags [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode)")
                Result(success = true, statusCode = responseCode, responseBody = formattedDisplay)
            } else {
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(success = false, statusCode = responseCode, responseBody = formattedDisplay, errorMessage = "HTTP $responseCode")
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error fetching /api/tags from $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(success = false, errorMessage = errorDetail)
        }
    }

    suspend fun sendTextToSpeechIntent(
        context: Context,
        text: String,
        targetApp: String = "cool-tts",
        voice: String = "default",
        speed: Float = 1.0f,
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/ui/TextToSpeech?app=$targetApp"

        val logPrefix = "[ui.TextToSpeech -> $targetApp]"
        addLog("$logPrefix Synthesizing text:\n\"$text\"")

        try {
            val jsonBody = JSONObject().apply {
                put("intent", "ui.TextToSpeech")
                put("app", targetApp)
                put("text", text)
                put("voice", voice)
                put("speed", speed)
                put("reply", true)
                put("Accept", "*")
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "audio/wav, application/json, */*")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonBody.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream

            val responseTextBuilder = StringBuilder()
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val buffer = CharArray(1024)
            var bytesRead: Int

            while (reader.read(buffer).also { bytesRead = it } != -1) {
                responseTextBuilder.appendRange(buffer, 0, bytesRead)
                val currentText = responseTextBuilder.toString().trim()
                if (currentText.startsWith("{") && currentText.endsWith("}")) break
            }

            val responseText = responseTextBuilder.toString()
            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.joinToString("\n---\n") { it.toString(2) }
            } else {
                responseText.ifBlank { "(Audio or stream response)" }
            }

            Log.i(TAG, "Sent ui.TextToSpeech to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode):\n$formattedDisplay")
                Result(success = true, statusCode = responseCode, responseBody = formattedDisplay)
            } else {
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(success = false, statusCode = responseCode, responseBody = formattedDisplay, errorMessage = "HTTP $responseCode")
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending ui.TextToSpeech to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(success = false, errorMessage = errorDetail)
        }
    }

    suspend fun sendPickFileIntent(
        context: Context,
        holdOpenForWrite: Boolean = true,
        targetApp: String = "cool-clips",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/fs/PickFile?app=$targetApp"

        val logPrefix = "[fs.PickFile -> $targetApp]"
        addLog("$logPrefix Requesting PickFile (holdOpenForWrite=$holdOpenForWrite)")

        try {
            val jsonBody = JSONObject().apply {
                put("intent", "fs.PickFile")
                put("app", targetApp)
                put("holdOpenForWrite", holdOpenForWrite)
                put("reply", true)
                put("Accept", "*")
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "*/*")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonBody.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream

            val responseTextBuilder = StringBuilder()
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val buffer = CharArray(1024)
            var bytesRead: Int

            while (reader.read(buffer).also { bytesRead = it } != -1) {
                responseTextBuilder.appendRange(buffer, 0, bytesRead)
                val currentText = responseTextBuilder.toString().trim()
                if (currentText.startsWith("{") && currentText.endsWith("}")) break
            }

            val responseText = responseTextBuilder.toString()
            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.joinToString("\n---\n") { it.toString(2) }
            } else {
                responseText.ifBlank { "(Empty response body)" }
            }

            Log.i(TAG, "Sent fs.PickFile to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode):\n$formattedDisplay")
                Result(success = true, statusCode = responseCode, responseBody = formattedDisplay)
            } else {
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(success = false, statusCode = responseCode, responseBody = formattedDisplay, errorMessage = "HTTP $responseCode")
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending fs.PickFile to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(success = false, errorMessage = errorDetail)
        }
    }

    suspend fun sendXBlobBroadcast(
        context: Context,
        blobId: String,
        name: String,
        type: String,
        size: Long,
        dataType: String,
        data: String,
        targetApp: String = "cool-clips",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/sys/XBlobBroadcast?app=$targetApp"

        val logPrefix = "[XBlobBroadcast -> $targetApp]"
        addLog("$logPrefix Broadcasting blob $blobId: $name ($type, $size bytes)")

        try {
            val blobJson = JSONObject().apply {
                put("name", name)
                put("type", type)
                put("size", size)
                put("_dataType", dataType)
                put("data", data)
            }

            val jsonBody = JSONObject().apply {
                put("event", "XBlobBroadcast")
                put("blobId", blobId)
                put("app", targetApp)
                put("blob", blobJson)
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonBody.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) connection.inputStream else connection.errorStream

            val responseTextBuilder = StringBuilder()
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val buffer = CharArray(1024)
            var bytesRead: Int

            while (reader.read(buffer).also { bytesRead = it } != -1) {
                responseTextBuilder.appendRange(buffer, 0, bytesRead)
                val currentText = responseTextBuilder.toString().trim()
                if (currentText.startsWith("{") && currentText.endsWith("}")) break
            }

            val responseText = responseTextBuilder.toString()
            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.joinToString("\n---\n") { it.toString(2) }
            } else {
                responseText.ifBlank { "(Empty response body)" }
            }

            Log.i(TAG, "Sent XBlobBroadcast to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode):\n$formattedDisplay")
                Result(success = true, statusCode = responseCode, responseBody = formattedDisplay)
            } else {
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(success = false, statusCode = responseCode, responseBody = formattedDisplay, errorMessage = "HTTP $responseCode")
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending XBlobBroadcast to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(success = false, errorMessage = errorDetail)
        }
    }

    suspend fun sendSaveAsIntent(
        context: Context,
        name: String,
        type: String,
        size: Long,
        dataType: String,
        data: String,
        targetApp: String = "cool-clips",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/fs/SaveAs?app=$targetApp"

        val logPrefix = "[fs.SaveAs -> $targetApp]"
        addLog("$logPrefix Saving file: $name ($type, $size bytes)")

        try {
            val blobJson = JSONObject().apply {
                put("name", name)
                put("type", type)
                put("size", size)
                put("_dataType", dataType)
                put("data", data)
            }

            val jsonBody = JSONObject().apply {
                put("intent", "fs.SaveAs")
                put("app", targetApp)
                put("blob", blobJson)
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 30000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonBody.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream
            }

            val responseTextBuilder = StringBuilder()
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val buffer = CharArray(1024)
            var bytesRead: Int

            while (reader.read(buffer).also { bytesRead = it } != -1) {
                responseTextBuilder.appendRange(buffer, 0, bytesRead)
                val currentText = responseTextBuilder.toString().trim()
                if (currentText.startsWith("{") && currentText.endsWith("}")) break
            }

            val responseText = responseTextBuilder.toString()
            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.joinToString("\n---\n") { it.toString(2) }
            } else {
                responseText.ifBlank { "(Empty response body)" }
            }

            Log.i(TAG, "Sent fs.SaveAs to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                addLog("$logPrefix SUCCESS ($responseCode):\n$formattedDisplay")
                Result(
                    success = true,
                    statusCode = responseCode,
                    responseBody = formattedDisplay,
                )
            } else {
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(
                    success = false,
                    statusCode = responseCode,
                    responseBody = formattedDisplay,
                    errorMessage = "HTTP $responseCode: $formattedDisplay",
                )
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending fs.SaveAs to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(
                success = false,
                errorMessage = errorDetail,
            )
        }
    }

    suspend fun sendTextProcessIntent(
        context: Context,
        text: String,
        targetApp: String,
        canReplace: Boolean = true,
        namespace: String = "ui",
        action: String = "TextProcess",
    ): Result = withContext(Dispatchers.IO) {
        val baseUrl = getServerUrl(context)
        val fullUrl = "$baseUrl/intent/$namespace/$action?app=$targetApp"

        val logPrefix = "[$namespace.$action -> $targetApp]"
        addLog("$logPrefix Dispatching text:\n\"$text\"")

        try {
            val jsonBody = JSONObject().apply {
                put("intent", "$namespace.$action")
                put("app", targetApp)
                put("text", text)
                if (canReplace) {
                    put("replace", true)
                    put("reply", true)
                    put("Accept", "*")
                }
            }

            val url = URL(fullUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 15000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                if (canReplace) {
                    setRequestProperty("Accept", "*/*")
                } else {
                    setRequestProperty("Accept", "application/json")
                }
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonBody.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            val inputStream = if (responseCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream
            }

            val responseTextBuilder = StringBuilder()
            val reader = BufferedReader(InputStreamReader(inputStream ?: "".byteInputStream(), "UTF-8"))
            val buffer = CharArray(1024)
            var bytesRead: Int

            while (reader.read(buffer).also { bytesRead = it } != -1) {
                responseTextBuilder.appendRange(buffer, 0, bytesRead)
                val currentText = responseTextBuilder.toString().trim()

                if (currentText.startsWith("{") && currentText.endsWith("}")) {
                    break
                }
                if (currentText.contains("--MatchboxFrameBoundary_") &&
                    (currentText.contains("--\r\n") || currentText.contains("--\n"))
                ) {
                    break
                }
            }

            val responseText = responseTextBuilder.toString()
            val jsonObjects = extractJsonObjects(responseText)
            val formattedDisplay = if (jsonObjects.isNotEmpty()) {
                jsonObjects.joinToString("\n---\n") { it.toString(2) }
            } else {
                responseText.ifBlank { "(Empty response body)" }
            }

            Log.i(TAG, "Sent intent to $targetApp [$responseCode]: $responseText")

            if (responseCode in 200..299) {
                val extracted = if (canReplace) extractReplacementText(responseText) else null
                val result = Result(
                    success = true,
                    statusCode = responseCode,
                    responseBody = formattedDisplay,
                    replacementText = extracted,
                )

                val logText = if (!extracted.isNullOrBlank()) {
                    "$logPrefix SUCCESS ($responseCode):\n$formattedDisplay\n\n[Replacement Text]: $extracted"
                } else {
                    "$logPrefix SUCCESS ($responseCode):\n$formattedDisplay"
                }
                addLog(logText)
                result
            } else {
                val errorMsg = "HTTP $responseCode: $formattedDisplay"
                addLog("$logPrefix ERROR ($responseCode):\n$formattedDisplay")
                Result(
                    success = false,
                    statusCode = responseCode,
                    responseBody = formattedDisplay,
                    errorMessage = errorMsg,
                )
            }
        } catch (e: Exception) {
            val errorDetail = "${e.javaClass.simpleName}: ${e.message ?: "Network error"}"
            Log.e(TAG, "Error sending intent to $fullUrl", e)
            addLog("$logPrefix FAILED: $errorDetail")
            Result(
                success = false,
                errorMessage = errorDetail,
            )
        }
    }
}
