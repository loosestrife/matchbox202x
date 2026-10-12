package org.xintent.flammenwerfer

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4

import org.junit.Test
import org.junit.runner.RunWith

import org.junit.Assert.*

/**
 * Instrumented test, which will execute on an Android device.
 *
 * See [testing documentation](http://d.android.com/tools/testing).
 */
@RunWith(AndroidJUnit4::class)
class ExampleInstrumentedTest {
    @Test
    fun useAppContext() {
        // Context of the app under test.
        val appContext = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("org.xintent.flammenwerfer", appContext.packageName)
    }

    @Test
    fun testHostnameAndManifestAdvertising() {
        val appContext = InstrumentationRegistry.getInstrumentation().targetContext

        // Default hostname should be user-phone
        assertEquals("user-phone", XIntentClient.getHostname(appContext))
        assertEquals("user-phone:flammenwerfer", XIntentClient.getAdvertisedName(appContext))
        assertTrue(XIntentClient.getManifest(appContext).contains("id = \"user-phone:flammenwerfer\""))

        // Set custom hostname (e.g. user-tablet)
        XIntentClient.setHostname(appContext, "user-tablet")
        assertEquals("user-tablet", XIntentClient.getHostname(appContext))
        assertEquals("user-tablet:flammenwerfer", XIntentClient.getAdvertisedName(appContext))
        assertTrue(XIntentClient.getManifest(appContext).contains("id = \"user-tablet:flammenwerfer\""))
        assertTrue(XIntentClient.getManifest(appContext).contains("name = \"user-tablet:flammenwerfer\""))

        // Reset back to default
        XIntentClient.setHostname(appContext, "user-phone")
    }

    @Test
    fun testUdpWakePortConfiguration() {
        val appContext = InstrumentationRegistry.getInstrumentation().targetContext

        // Default UDP port
        assertEquals(12346, XIntentClient.getUdpPort(appContext))

        // Custom UDP port
        XIntentClient.setUdpPort(appContext, 12347)
        assertEquals(12347, XIntentClient.getUdpPort(appContext))

        // Reset
        XIntentClient.setUdpPort(appContext, 12346)
    }
}