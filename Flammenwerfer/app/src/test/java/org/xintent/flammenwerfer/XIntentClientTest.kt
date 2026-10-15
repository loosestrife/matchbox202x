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
