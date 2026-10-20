package org.xintent.flammenwerfer.protocol

import android.util.Base64
import org.json.JSONObject

object XIntentProtocolParser {

    fun parseBlobId(value: Any?): Long? {
        if (value == null) return null
        if (value is Number) {
            val l = value.toLong()
            return if (l > 0) l else null
        }
        val str = value.toString().trim()
        if (str.isEmpty() || str == "0" || str == "0x0") return null
        if (str.startsWith("0x", ignoreCase = true)) {
            return try { str.substring(2).toLong(16) } catch (_: Exception) { null }
        }
        return try {
            val l = str.toLong()
            if (l > 0) l else null
        } catch (_: Exception) {
            try { str.toLong(16) } catch (_: Exception) { null }
        }
    }

    fun formatBlobIdHex(blobId: Long): String {
        if (blobId <= 0) return ""
        return "0x" + blobId.toString(16)
    }

    fun extractJsonObjects(text: String): List<JSONObject> {
        val results = mutableListOf<JSONObject>()
        if (text.isBlank()) return results

        var depth = 0
        var startIndex = -1
        for (i in text.indices) {
            val c = text[i]
            if (c == '{') {
                if (depth == 0) startIndex = i
                depth++
            } else if (c == '}') {
                if (depth > 0) {
                    depth--
                    if (depth == 0 && startIndex != -1) {
                        val candidate = text.substring(startIndex, i + 1)
                        try {
                            results.add(JSONObject(candidate))
                        } catch (_: Exception) {}
                        startIndex = -1
                    }
                }
            }
        }
        return results
    }

    fun findSequence(source: ByteArray, target: ByteArray): Int {
        if (target.isEmpty() || source.size < target.size) return -1
        for (i in 0..source.size - target.size) {
            var match = true
            for (j in target.indices) {
                if (source[i + j] != target[j]) {
                    match = false
                    break
                }
            }
            if (match) return i
        }
        return -1
    }

    fun splitBytesByDelimiter(source: ByteArray, delimiter: ByteArray): List<ByteArray> {
        val result = mutableListOf<ByteArray>()
        var start = 0
        while (true) {
            if (start >= source.size) break
            val pos = findSequence(source.copyOfRange(start, source.size), delimiter)
            if (pos == -1) {
                if (start < source.size) {
                    result.add(source.copyOfRange(start, source.size))
                }
                break
            }
            val actualPos = start + pos
            if (actualPos > start) {
                result.add(source.copyOfRange(start, actualPos))
            }
            start = actualPos + delimiter.size
        }
        return result
    }

    fun trimWavBinaryBytes(bytes: ByteArray): ByteArray {
        if (bytes.size >= 44 &&
            bytes[0] == 'R'.code.toByte() && bytes[1] == 'I'.code.toByte() &&
            bytes[2] == 'F'.code.toByte() && bytes[3] == 'F'.code.toByte() &&
            bytes[8] == 'W'.code.toByte() && bytes[9] == 'A'.code.toByte() &&
            bytes[10] == 'V'.code.toByte() && bytes[11] == 'E'.code.toByte()
        ) {
            for (i in 0 until bytes.size - 8) {
                if (bytes[i] == 'd'.code.toByte() && bytes[i + 1] == 'a'.code.toByte() &&
                    bytes[i + 2] == 't'.code.toByte() && bytes[i + 3] == 'a'.code.toByte()
                ) {
                    val subchunk2Size = (bytes[i + 4].toInt() and 0xFF) or
                            ((bytes[i + 5].toInt() and 0xFF) shl 8) or
                            ((bytes[i + 6].toInt() and 0xFF) shl 16) or
                            ((bytes[i + 7].toInt() and 0xFF) shl 24)
                    val totalWavSize = i + 8 + subchunk2Size
                    if (totalWavSize in 44..bytes.size) {
                        return bytes.copyOfRange(0, totalWavSize)
                    }
                    break
                }
            }
        }
        return bytes
    }

    fun extractAudioBytesFromRawResponse(rawBytes: ByteArray): ByteArray? {
        if (rawBytes.isEmpty()) return null

        if (rawBytes.size >= 12 &&
            rawBytes[0] == 'R'.code.toByte() && rawBytes[1] == 'I'.code.toByte() &&
            rawBytes[2] == 'F'.code.toByte() && rawBytes[3] == 'F'.code.toByte() &&
            rawBytes[8] == 'W'.code.toByte() && rawBytes[9] == 'A'.code.toByte() &&
            rawBytes[10] == 'V'.code.toByte() && rawBytes[11] == 'E'.code.toByte()
        ) {
            return trimWavBinaryBytes(rawBytes)
        }
        if (rawBytes.size >= 3 && rawBytes[0] == 'I'.code.toByte() && rawBytes[1] == 'D'.code.toByte() && rawBytes[2] == '3'.code.toByte()) return rawBytes
        if (rawBytes.size >= 4 && rawBytes[0] == 'O'.code.toByte() && rawBytes[1] == 'g'.code.toByte()) return rawBytes
        if (rawBytes.size >= 4 && rawBytes[0] == 'f'.code.toByte() && rawBytes[1] == 'L'.code.toByte()) return rawBytes

        val sepPos = findSequence(rawBytes, "\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
        val sepLen = if (sepPos != -1) 4 else {
            val altPos = findSequence(rawBytes, "\n\n".toByteArray(Charsets.ISO_8859_1))
            if (altPos != -1) 2 else -1
        }

        if (sepPos != -1) {
            val headerText = try { String(rawBytes.copyOfRange(0, sepPos), Charsets.ISO_8859_1) } catch (_: Exception) { "" }
            if (headerText.contains("Content-Type:", ignoreCase = true) || headerText.contains("Content-Encoding:", ignoreCase = true) || headerText.contains("Content-Transfer-Encoding:", ignoreCase = true)) {
                val bodyBytes = rawBytes.copyOfRange(sepPos + sepLen, rawBytes.size)
                if (bodyBytes.isEmpty()) return null

                if (bodyBytes.size >= 12 &&
                    bodyBytes[0] == 'R'.code.toByte() && bodyBytes[1] == 'I'.code.toByte() &&
                    bodyBytes[2] == 'F'.code.toByte() && bodyBytes[3] == 'F'.code.toByte() &&
                    bodyBytes[8] == 'W'.code.toByte() && bodyBytes[9] == 'A'.code.toByte() &&
                    bodyBytes[10] == 'V'.code.toByte() && bodyBytes[11] == 'E'.code.toByte()
                ) {
                    return trimWavBinaryBytes(bodyBytes)
                }

                val isBase64 = headerText.contains("base64", ignoreCase = true)
                if (isBase64) {
                    return try {
                        val strBody = String(bodyBytes, Charsets.UTF_8).trim()
                        val decoded = Base64.decode(strBody, Base64.DEFAULT)
                        if (decoded.isNotEmpty()) trimWavBinaryBytes(decoded) else bodyBytes
                    } catch (_: Exception) {
                        bodyBytes
                    }
                }

                return trimWavBinaryBytes(bodyBytes)
            }
        }

        val respText = try { String(rawBytes, Charsets.UTF_8).trim() } catch (_: Exception) { "" }
        if (respText.startsWith("{")) {
            return try {
                val respJson = JSONObject(respText)
                val blobDataObj = respJson.optJSONObject("blob")
                if (blobDataObj != null && blobDataObj.has("data")) {
                    Base64.decode(blobDataObj.getString("data"), Base64.DEFAULT)
                } else if (blobDataObj != null && blobDataObj.has("buffer")) {
                    Base64.decode(blobDataObj.getString("buffer"), Base64.DEFAULT)
                } else {
                    val rawBlobStr = respJson.optString("blob")
                    if (rawBlobStr.isNotBlank()) {
                        Base64.decode(rawBlobStr, Base64.DEFAULT)
                    } else null
                }
            } catch (_: Exception) {
                null
            }
        }

        try {
            val decoded = Base64.decode(respText, Base64.DEFAULT)
            if (decoded.isNotEmpty() && decoded.size > 10) {
                return decoded
            }
        } catch (_: Exception) {}

        return rawBytes
    }

    fun parseMultipartRawBytes(rawBytes: ByteArray): Pair<List<JSONObject>, ByteArray?> {
        if (rawBytes.isEmpty()) return Pair(emptyList(), null)

        val rawStr = try { String(rawBytes, Charsets.ISO_8859_1) } catch (_: Exception) { "" }
        if (!rawStr.contains("MatchboxFrameBoundary")) {
            val jsonList = extractJsonObjects(String(rawBytes, Charsets.UTF_8))
            val audio = extractAudioBytesFromRawResponse(rawBytes)
            return Pair(jsonList, audio)
        }

        val jsonList = mutableListOf<JSONObject>()
        var extractedAudio: ByteArray? = null

        val boundaryLine = rawStr.lines().firstOrNull { it.contains("MatchboxFrameBoundary") }?.trim() ?: ""
        var boundary = boundaryLine
        if (boundary.startsWith("--")) boundary = boundary.substring(2)
        if (boundary.endsWith("--")) boundary = boundary.substring(0, boundary.length - 2)
        boundary = boundary.trim()

        if (boundary.isBlank()) {
            val jsonListFallback = extractJsonObjects(String(rawBytes, Charsets.UTF_8))
            val audioFallback = extractAudioBytesFromRawResponse(rawBytes)
            return Pair(jsonListFallback, audioFallback)
        }

        val boundaryBytes = ("--" + boundary).toByteArray(Charsets.ISO_8859_1)
        val parts = splitBytesByDelimiter(rawBytes, boundaryBytes)

        for (partBytes in parts) {
            if (partBytes.isEmpty()) continue
            val headerSep = findSequence(partBytes, "\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
            val headerSepLen = if (headerSep != -1) 4 else {
                val altSep = findSequence(partBytes, "\n\n".toByteArray(Charsets.ISO_8859_1))
                if (altSep != -1) 2 else -1
            }

            val headerText = if (headerSep != -1) {
                try { String(partBytes.copyOfRange(0, headerSep), Charsets.ISO_8859_1) } catch (_: Exception) { "" }
            } else ""

            val bodyBytes = if (headerSep != -1) {
                partBytes.copyOfRange(headerSep + headerSepLen, partBytes.size)
            } else {
                partBytes
            }

            if (bodyBytes.isEmpty()) continue

            val bodyStr = try { String(bodyBytes, Charsets.UTF_8).trim() } catch (_: Exception) { "" }
            if (bodyStr.startsWith("{") && bodyStr.endsWith("}")) {
                try {
                    val jsonObj = JSONObject(bodyStr)
                    val blobIdHeader = Regex("""X-(?:Attached-)?Blob-Id\s*:\s*(\w+)""", RegexOption.IGNORE_CASE).find(headerText)?.groupValues?.get(1)
                    if (blobIdHeader != null && !jsonObj.has("data_blob") && !jsonObj.has("dataBlob")) {
                        parseBlobId(blobIdHeader)?.let { jsonObj.put("data_blob", it) }
                    }
                    jsonList.add(jsonObj)
                    continue
                } catch (_: Exception) {}
            }

            val audioFromPart = extractAudioBytesFromRawResponse(bodyBytes)
            if (audioFromPart != null && audioFromPart.size > 10) {
                extractedAudio = audioFromPart
            }
        }

        return Pair(jsonList, extractedAudio)
    }

    fun extractFileFromPickFileResponse(rawBytes: ByteArray): Pair<String, ByteArray>? {
        if (rawBytes.isEmpty()) return null
        val rawStr = try { String(rawBytes, Charsets.ISO_8859_1) } catch (_: Exception) { "" }
        val boundaryLine = rawStr.lines().firstOrNull { it.contains("MatchboxFrameBoundary") }?.trim() ?: ""
        var boundary = boundaryLine
        if (boundary.startsWith("--")) boundary = boundary.substring(2)
        if (boundary.endsWith("--")) boundary = boundary.substring(0, boundary.length - 2)
        boundary = boundary.trim()

        if (boundary.isNotBlank()) {
            val boundaryBytes = ("--" + boundary).toByteArray(Charsets.ISO_8859_1)
            val parts = splitBytesByDelimiter(rawBytes, boundaryBytes)
            var foundFileName = "picked_desktop_file"

            for (partBytes in parts) {
                if (partBytes.isEmpty()) continue
                val headerSep = findSequence(partBytes, "\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
                val headerSepLen = if (headerSep != -1) 4 else 2
                if (headerSep != -1) {
                    val headerText = String(partBytes.copyOfRange(0, headerSep), Charsets.UTF_8)
                    val bodyBytes = partBytes.copyOfRange(headerSep + headerSepLen, partBytes.size)

                    if (headerText.contains("filename=", ignoreCase = true)) {
                        val m = Regex("""filename\s*=\s*"?([^";]+)"?""", RegexOption.IGNORE_CASE).find(headerText)
                        if (m != null) foundFileName = m.groupValues[1]
                    }

                    if (!headerText.contains("application/json", ignoreCase = true) && bodyBytes.isNotEmpty()) {
                        return Pair(foundFileName, bodyBytes)
                    }
                }
            }
        }
        return null
    }
}
