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
}
