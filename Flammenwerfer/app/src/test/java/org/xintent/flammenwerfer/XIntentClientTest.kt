package org.xintent.flammenwerfer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class XIntentClientTest {

    @Test
    fun testDefaultConstants() {
        assertEquals("http://10.0.2.2:12345", XIntentClient.DEFAULT_SERVER_URL)
        assertNotNull(XIntentClient.FLAMMENWERFER_MANIFEST)
        assertTrue(XIntentClient.FLAMMENWERFER_MANIFEST.contains("[app]"))
        assertTrue(XIntentClient.FLAMMENWERFER_MANIFEST.contains("id ="))
        assertTrue(XIntentClient.FLAMMENWERFER_MANIFEST.contains("\"ui.TextToSpeech\" = true"))
    }

    @Test
    fun testLogHistoryAndBuffer() {
        XIntentClient.addLog("[TEST] Automated Unit Test Log Entry")
        val history = XIntentClient.getLogHistory()
        assertTrue(history.contains("[TEST] Automated Unit Test Log Entry"))
    }

    @Test
    fun testUnlinkXBlobHandlesBlankAndInvalid() {
        // Should return safely without throwing exception for non-positive u32 blobId
        XIntentClient.unlinkXBlob("http://localhost:12345", 0L)
        XIntentClient.unlinkXBlob("http://localhost:12345", -1L)
    }

    @Test
    fun testDataBlobRegexExtraction() {
        val sampleResponseText = """{"payloadBlob":30356,"dataBlob":30355,"messageType":"XINTENT_EVENT_V0"}"""
        val dataBlobRegex = Regex(""""?\b(?:X-Attached-Blob-Id|X-Blob-Id|data_blob|dataBlob)"?\s*[:=]\s*"?(\d+)""", RegexOption.IGNORE_CASE)
        val matches = dataBlobRegex.findAll(sampleResponseText).map { XIntentClient.parseBlobId(it.groupValues[1]) }.toList()
        assertEquals(1, matches.size)
        assertEquals(30355L, matches[0])
    }

    @Test
    fun testFormatBlobIdHex() {
        assertEquals("0x552", XIntentClient.formatBlobIdHex(1362L))
        assertEquals("0x7693", XIntentClient.formatBlobIdHex(30355L))
        assertEquals("", XIntentClient.formatBlobIdHex(0L))
        assertEquals("", XIntentClient.formatBlobIdHex(-1L))
    }

    @Test
    fun testParseBlobId() {
        assertEquals(1362L, XIntentClient.parseBlobId(1362))
        assertEquals(1362L, XIntentClient.parseBlobId(1362L))
        assertEquals(1362L, XIntentClient.parseBlobId("1362"))
        assertEquals(1362L, XIntentClient.parseBlobId("0x552"))
        assertEquals(null, XIntentClient.parseBlobId(0))
        assertEquals(null, XIntentClient.parseBlobId("0x0"))
        assertEquals(null, XIntentClient.parseBlobId(""))
        assertEquals(null, XIntentClient.parseBlobId(null))
    }

    @Test
    fun testTrimWavBinaryBytes() {
        // Construct a synthetic 44-byte WAV header with 10 bytes PCM = 54 bytes total, plus 4 trailing delimiter bytes
        val wavBuf = ByteArray(58)
        wavBuf[0] = 'R'.code.toByte(); wavBuf[1] = 'I'.code.toByte(); wavBuf[2] = 'F'.code.toByte(); wavBuf[3] = 'F'.code.toByte()
        wavBuf[8] = 'W'.code.toByte(); wavBuf[9] = 'A'.code.toByte(); wavBuf[10] = 'V'.code.toByte(); wavBuf[11] = 'E'.code.toByte()
        wavBuf[36] = 'd'.code.toByte(); wavBuf[37] = 'a'.code.toByte(); wavBuf[38] = 't'.code.toByte(); wavBuf[39] = 'a'.code.toByte()
        // subchunk2Size = 10 (bytes 40-43)
        wavBuf[40] = 10; wavBuf[41] = 0; wavBuf[42] = 0; wavBuf[43] = 0
        // trailing 4 bytes
        wavBuf[54] = '\r'.code.toByte(); wavBuf[55] = '\n'.code.toByte(); wavBuf[56] = '-'.code.toByte(); wavBuf[57] = '-'.code.toByte()

        val trimmed = XIntentClient.trimWavBinaryBytes(wavBuf)
        assertEquals(54, trimmed.size)
    }

    @Test
    fun testExtractAudioBytesFromRawResponseBinary() {
        val wavBuf = ByteArray(50)
        wavBuf[0] = 'R'.code.toByte(); wavBuf[1] = 'I'.code.toByte(); wavBuf[2] = 'F'.code.toByte(); wavBuf[3] = 'F'.code.toByte()
        wavBuf[8] = 'W'.code.toByte(); wavBuf[9] = 'A'.code.toByte(); wavBuf[10] = 'V'.code.toByte(); wavBuf[11] = 'E'.code.toByte()
        wavBuf[36] = 'd'.code.toByte(); wavBuf[37] = 'a'.code.toByte(); wavBuf[38] = 't'.code.toByte(); wavBuf[39] = 'a'.code.toByte()
        wavBuf[40] = 6; wavBuf[41] = 0; wavBuf[42] = 0; wavBuf[43] = 0

        val extracted = XIntentClient.extractAudioBytesFromRawResponse(wavBuf)
        assertNotNull(extracted)
        assertEquals(50, extracted!!.size)
    }

    @Test
    fun testParseMediaPlayTargets() {
        val sampleTagsJson = """
        {
          "apps": {
            "dlna-living-room-tv": {
              "name": "DLNA (Living Room TV)",
              "intents": {
                "media.Play": { "Accept": "video/webm; codecs=\"vp8\", video/mp4" }
              }
            },
            "user-desktop": {
              "name": "User Desktop",
              "intents": {
                "media.Play": { "Accept": "*/*" }
              }
            }
          }
        }
        """.trimIndent()

        val targets = XIntentClient.parseMediaPlayTargets(sampleTagsJson)
        assertTrue(targets.any { it.appId == "dlna-living-room-tv" })
        assertTrue(targets.any { it.appId == "user-desktop" })

        val dlnaTarget = targets.first { it.appId == "dlna-living-room-tv" }
        assertEquals("DLNA (Living Room TV)", dlnaTarget.name)
        assertTrue(dlnaTarget.accept.contains("video/webm"))
    }
}
