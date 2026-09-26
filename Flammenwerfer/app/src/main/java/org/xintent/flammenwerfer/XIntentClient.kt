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
            // If the response was valid JSON but contained no replacement text field (e.g. {"status":"ok"}), return null
            return null
        }

        return trimmed
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
