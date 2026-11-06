package org.xintent.flammenwerfer

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.clearElement
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.getText
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.DriverAtoms.webKeys
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.hamcrest.CoreMatchers.containsString
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.xintent.flammenwerfer.config.XIntentPreferences
import org.xintent.flammenwerfer.net.XIntentTransport
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class LiveMigrateEspressoWebTest {

    private var scenario: ActivityScenario<CardsActivity>? = null

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val args = InstrumentationRegistry.getArguments()
        val serverUrl = args.getString("serverUrl")?.takeIf { it.isNotBlank() } ?: "http://127.0.0.1:12358"
        val hostname = args.getString("hostname")?.takeIf { it.isNotBlank() } ?: "user-phone"

        XIntentTransport.disconnectWebSocket()
        XIntentPreferences.setServerUrl(context, serverUrl)
        XIntentPreferences.setHostname(context, hostname)

        val launchIntent = Intent(context, CardsActivity::class.java).apply {
            putExtra(CardsActivity.EXTRA_APP_NAME, "intent-test-card")
            putExtra(CardsActivity.EXTRA_CARD_NAME, "index")
        }
        scenario = ActivityScenario.launch(launchIntent)
        XIntentClient.connectWebSocket(context)
    }

    @After
    fun tearDown() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        XIntentTransport.disconnectWebSocket(context)
        scenario?.close()
    }

    private fun evaluateInWebView(jsExpression: String): String {
        val resultRef = AtomicReference("")
        val latch = CountDownLatch(1)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val wv = CardsActivity.instance?.cardWebView
            if (wv == null) {
                latch.countDown()
            } else {
                wv.evaluateJavascript(jsExpression) { value ->
                    resultRef.set(value ?: "")
                    latch.countDown()
                }
            }
        }
        latch.await(3, TimeUnit.SECONDS)
        return resultRef.get()
    }

    @Test
    fun receiveMigratedCoolTerminalAndInteractViaEspressoWeb() {
        // 1. Wait for incoming live-migrated cool-terminal card to load and hydrate in CardsActivity's WebView
        var hydratedReady = false
        val startMs = System.currentTimeMillis()
        while (System.currentTimeMillis() - startMs < 45000) {
            val stateStr = evaluateInWebView(
                "(function() { " +
                    "var s = document.getElementById('terminal-screen'); " +
                    "var b = document.getElementById('blob-badge'); " +
                    "return (s ? s.textContent : '') + '|||' + (b ? b.textContent : ''); " +
                    "})()"
            )
            if (stateStr.contains("LAPTOP_PTY_OK:4242") && stateStr.contains("DESKTOP_PTY_AFTER:5000")) {
                hydratedReady = true
                break
            }
            Thread.sleep(300)
        }
        assertTrue(
            "Expected Flammenwerfer WebView on ATD to receive and hydrate live-migrated cool-terminal card",
            hydratedReady,
        )

        // 2. Use Espresso Web to verify the hydrated 80x24 terminal screen and NATted/bus blob badges
        onWebView()
            .forceJavascriptEnabled()
            .withElement(findElement(Locator.ID, "terminal-screen"))
            .check(webMatches(getText(), containsString("LAPTOP_PTY_OK:4242")))
            .check(webMatches(getText(), containsString("DESKTOP_PTY_AFTER:5000")))

        onWebView()
            .withElement(findElement(Locator.ID, "in-blob-badge"))
            .check(webMatches(getText(), containsString("nat=0x")))
            .check(webMatches(getText(), containsString("bus=0x")))

        onWebView()
            .withElement(findElement(Locator.ID, "out-blob-badge"))
            .check(webMatches(getText(), containsString("nat=0x")))
            .check(webMatches(getText(), containsString("bus=0x")))

        // 3. Use Espresso Web to type a command into #cmd-input and click #send-btn in the migrated card
        onWebView()
            .withElement(findElement(Locator.ID, "cmd-input"))
            .perform(clearElement())
            .perform(webKeys("echo \"ATD_ESPRESSO_WEB_OK:\$((MIGRATE_SECRET + 1580))\""))

        onWebView()
            .withElement(findElement(Locator.ID, "send-btn"))
            .perform(webClick())

        // 4. Wait for the bash PTY output to stream back to Flammenwerfer's WebView and assert with Espresso Web
        var ptyReplyReady = false
        val ptyStartMs = System.currentTimeMillis()
        while (System.currentTimeMillis() - ptyStartMs < 12000) {
            val screenText = evaluateInWebView(
                "(function() { var s = document.getElementById('terminal-screen'); return s ? s.textContent : ''; })()"
            )
            if (screenText.contains("ATD_ESPRESSO_WEB_OK:5822")) {
                ptyReplyReady = true
                break
            }
            Thread.sleep(250)
        }
        assertTrue("Expected bash PTY output ATD_ESPRESSO_WEB_OK:5822 in WebView", ptyReplyReady)

        onWebView()
            .withElement(findElement(Locator.ID, "terminal-screen"))
            .check(webMatches(getText(), containsString("ATD_ESPRESSO_WEB_OK:5822")))
    }
}
