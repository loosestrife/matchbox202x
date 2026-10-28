package org.xintent.flammenwerfer.protocol

import android.util.Base64
import org.json.JSONObject

object XIntentProtocolParser {

    fun parseBlobId(value: Any?): Long? {
        if (value == null) return null
        if (value is Number) {
            return value.toLong().takeIf { it > 0 }
        }
        return parseBlobIdString(value.toString().trim())
    }

    private fun parseBlobIdString(str: String): Long? {
        if (str.isEmpty() || str == "0" || str == "0x0") return null
        if (str.startsWith("0x", ignoreCase = true)) {
            return try { str.substring(2).toLong(16).takeIf { it > 0 } } catch (_: Exception) { null }
        }
        return try {
            str.toLong().takeIf { it > 0 }
        } catch (_: Exception) {
            try { str.toLong(16).takeIf { it > 0 } } catch (_: Exception) { null }
        }
    }

    fun formatBlobIdHex(blobId: Long): String =
        if (blobId > 0) "0x" + blobId.toString(16) else ""

    fun extractJsonObjects(text: String): List<JSONObject> {
        if (text.isBlank()) return emptyList()
        val results = mutableListOf<JSONObject>()
        var depth = 0
        var startIndex = -1
        for (i in text.indices) {
            val c = text[i]
            if (c == '{') {
                if (depth == 0) startIndex = i
                depth++
            } else if (c == '}' && depth > 0) {
                depth--
                if (depth == 0 && startIndex != -1) {
                    try { results.add(JSONObject(text.substring(startIndex, i + 1))) } catch (_: Exception) {}
                    startIndex = -1
                }
            }
        }
        return results
    }

    fun findSequence(source: ByteArray, target: ByteArray): Int {
        if (target.isEmpty() || source.size < target.size) return -1
        for (i in 0..source.size - target.size) {
            if (matchesAt(source, target, i)) return i
        }
        return -1
    }

    private fun matchesAt(source: ByteArray, target: ByteArray, offset: Int): Boolean {
        for (j in target.indices) {
            if (source[offset + j] != target[j]) return false
        }
        return true
    }

    fun splitBytesByDelimiter(source: ByteArray, delimiter: ByteArray): List<ByteArray> {
        val result = mutableListOf<ByteArray>()
        var start = 0
        while (start < source.size) {
            val pos = findSequence(source.copyOfRange(start, source.size), delimiter)
            if (pos == -1) {
                result.add(source.copyOfRange(start, source.size))
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

    private fun isRiffWave(bytes: ByteArray): Boolean =
        bytes.size >= 12 &&
            matchesAt(bytes, "RIFF".toByteArray(Charsets.US_ASCII), 0) &&
            matchesAt(bytes, "WAVE".toByteArray(Charsets.US_ASCII), 8)

    private fun isAudioContainerSignature(bytes: ByteArray): Boolean {
        if (bytes.size >= 3 && matchesAt(bytes, "ID3".toByteArray(Charsets.US_ASCII), 0)) return true
        if (bytes.size >= 4 && matchesAt(bytes, "OggS".toByteArray(Charsets.US_ASCII), 0)) return true
        if (bytes.size >= 4 && matchesAt(bytes, "fLaC".toByteArray(Charsets.US_ASCII), 0)) return true
        return false
    }

    private fun readLittleEndianInt(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xFF) or
            ((bytes[offset + 1].toInt() and 0xFF) shl 8) or
            ((bytes[offset + 2].toInt() and 0xFF) shl 16) or
            ((bytes[offset + 3].toInt() and 0xFF) shl 24)

    fun trimWavBinaryBytes(bytes: ByteArray): ByteArray {
        if (bytes.size < 44 || !isRiffWave(bytes)) return bytes
        val dataPos = findSequence(bytes, "data".toByteArray(Charsets.US_ASCII))
        if (dataPos == -1 || dataPos > bytes.size - 8) return bytes
        val subchunk2Size = readLittleEndianInt(bytes, dataPos + 4)
        val totalWavSize = dataPos + 8 + subchunk2Size
        return if (totalWavSize in 44..bytes.size) bytes.copyOfRange(0, totalWavSize) else bytes
    }

    private fun splitHeaderAndBody(rawBytes: ByteArray): Pair<String, ByteArray>? {
        val crlfPos = findSequence(rawBytes, "\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
        if (crlfPos != -1) {
            val header = String(rawBytes.copyOfRange(0, crlfPos), Charsets.ISO_8859_1)
            return Pair(header, rawBytes.copyOfRange(crlfPos + 4, rawBytes.size))
        }
        val lfPos = findSequence(rawBytes, "\n\n".toByteArray(Charsets.ISO_8859_1))
        if (lfPos != -1) {
            val header = String(rawBytes.copyOfRange(0, lfPos), Charsets.ISO_8859_1)
            return Pair(header, rawBytes.copyOfRange(lfPos + 2, rawBytes.size))
        }
        return null
    }

    private fun extractAudioFromMimePart(rawBytes: ByteArray): Pair<Boolean, ByteArray?> {
        val split = splitHeaderAndBody(rawBytes) ?: return Pair(false, null)
        val (headerText, bodyBytes) = split
        val hasContentHeader = headerText.contains("Content-Type:", ignoreCase = true) ||
            headerText.contains("Content-Encoding:", ignoreCase = true) ||
            headerText.contains("Content-Transfer-Encoding:", ignoreCase = true)
        if (!hasContentHeader) return Pair(false, null)
        if (bodyBytes.isEmpty()) return Pair(true, null)

        if (!headerText.contains("base64", ignoreCase = true)) {
            return Pair(true, trimWavBinaryBytes(bodyBytes))
        }
        val decoded = try {
            val strBody = String(bodyBytes, Charsets.UTF_8).trim()
            Base64.decode(strBody, Base64.DEFAULT).takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
        return Pair(true, trimWavBinaryBytes(decoded ?: bodyBytes))
    }

    private fun extractAudioFromJsonText(respText: String): ByteArray? {
        return try {
            val respJson = JSONObject(respText)
            val blobObj = respJson.optJSONObject("blob")
            val b64 = when {
                blobObj != null && blobObj.has("data") -> blobObj.getString("data")
                blobObj != null && blobObj.has("buffer") -> blobObj.getString("buffer")
                else -> respJson.optString("blob")
            }
            if (b64.isNotBlank()) Base64.decode(b64, Base64.DEFAULT) else null
        } catch (_: Exception) {
            null
        }
    }

    fun extractAudioBytesFromRawResponse(rawBytes: ByteArray): ByteArray? {
        if (rawBytes.isEmpty()) return null
        if (isRiffWave(rawBytes)) return trimWavBinaryBytes(rawBytes)
        if (isAudioContainerSignature(rawBytes)) return rawBytes

        val (handledMime, mimeAudio) = extractAudioFromMimePart(rawBytes)
        if (handledMime) return mimeAudio

        val respText = try { String(rawBytes, Charsets.UTF_8).trim() } catch (_: Exception) { "" }
        if (respText.startsWith("{")) return extractAudioFromJsonText(respText)

        return try {
            val decoded = Base64.decode(respText, Base64.DEFAULT)
            if (decoded.size > 10) decoded else rawBytes
        } catch (_: Exception) {
            rawBytes
        }
    }

    private fun extractBoundaryToken(rawStr: String): String {
        val line = rawStr.lines().firstOrNull { it.contains("MatchboxFrameBoundary") }?.trim() ?: return ""
        return line.removePrefix("--").removeSuffix("--").trim()
    }

    private fun parseMultipartJsonFrame(headerText: String, bodyBytes: ByteArray): JSONObject? {
        val bodyStr = try { String(bodyBytes, Charsets.UTF_8).trim() } catch (_: Exception) { "" }
        if (!bodyStr.startsWith("{") || !bodyStr.endsWith("}")) return null
        return try {
            val jsonObj = JSONObject(bodyStr)
            val blobIdHeader = Regex("""X-(?:Attached-)?Blob-Id\s*:\s*(\w+)""", RegexOption.IGNORE_CASE)
                .find(headerText)?.groupValues?.get(1)
            if (blobIdHeader != null && !jsonObj.has("data_blob") && !jsonObj.has("dataBlob")) {
                parseBlobId(blobIdHeader)?.let { jsonObj.put("data_blob", it) }
            }
            jsonObj
        } catch (_: Exception) {
            null
        }
    }

    fun parseMultipartRawBytes(rawBytes: ByteArray): Pair<List<JSONObject>, ByteArray?> {
        if (rawBytes.isEmpty()) return Pair(emptyList(), null)
        val rawStr = try { String(rawBytes, Charsets.ISO_8859_1) } catch (_: Exception) { "" }
        val boundary = extractBoundaryToken(rawStr)
        if (boundary.isBlank()) {
            return Pair(extractJsonObjects(String(rawBytes, Charsets.UTF_8)), extractAudioBytesFromRawResponse(rawBytes))
        }

        val jsonList = mutableListOf<JSONObject>()
        var extractedAudio: ByteArray? = null
        val parts = splitBytesByDelimiter(rawBytes, "--$boundary".toByteArray(Charsets.ISO_8859_1))

        for (partBytes in parts) {
            if (partBytes.isEmpty()) continue
            val (headerText, bodyBytes) = splitHeaderAndBody(partBytes) ?: Pair("", partBytes)
            if (bodyBytes.isEmpty()) continue

            val jsonObj = parseMultipartJsonFrame(headerText, bodyBytes)
            if (jsonObj != null) {
                jsonList.add(jsonObj)
                continue
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
        val boundary = extractBoundaryToken(rawStr)
        if (boundary.isBlank()) return null

        val parts = splitBytesByDelimiter(rawBytes, "--$boundary".toByteArray(Charsets.ISO_8859_1))
        var foundFileName = "picked_desktop_file"

        for (partBytes in parts) {
            val (headerText, bodyBytes) = splitHeaderAndBody(partBytes) ?: continue
            Regex("""filename\s*=\s*"?([^";]+)"?""", RegexOption.IGNORE_CASE)
                .find(headerText)?.groupValues?.get(1)?.let { foundFileName = it }
            if (!headerText.contains("application/json", ignoreCase = true) && bodyBytes.isNotEmpty()) {
                return Pair(foundFileName, bodyBytes)
            }
        }
        return null
    }
}
