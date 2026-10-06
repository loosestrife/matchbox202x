package org.xintent.flammenwerfer

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.runBlocking
import org.xintent.flammenwerfer.ui.theme.FlammenwerferTheme

class CardsActivity : ComponentActivity() {

    companion object {
        const val EXTRA_APP_NAME = "extra_app_name"
        const val EXTRA_CARD_NAME = "extra_card_name"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val appName = intent.getStringExtra(EXTRA_APP_NAME) ?: "intent-test-card"
        val cardName = intent.getStringExtra(EXTRA_CARD_NAME) ?: "index"

        setContent {
            FlammenwerferTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    CardScreen(
                        appName = appName,
                        cardName = cardName,
                        onClose = { finish() },
                        modifier = Modifier.padding(innerPadding),
                    )
                }
            }
        }
    }
}

class XIntentJSBridge(private val context: ComponentActivity) {
    @Suppress("unused")
    @JavascriptInterface
    fun postIntent(namespace: String, action: String, appName: String, jsonPayload: String) {
        runBlocking {
            XIntentClient.sendTextProcessIntent(
                context = context.applicationContext,
                text = jsonPayload,
                targetApp = appName,
                namespace = namespace,
                action = action,
            )
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun CardScreen(
    appName: String,
    cardName: String,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val activity = context as? ComponentActivity
    val baseUrl = remember { XIntentClient.getServerUrl(context) }
    val cardUrl = remember { "$baseUrl/apps/$appName/$cardName" }

    var webViewRef: WebView? = remember { null }

    Column(modifier = modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(onClick = onClose) {
                Text("Close")
            }

            Text(
                text = " $appName / $cardName",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 8.dp),
            )

            Button(onClick = { webViewRef?.reload() }) {
                Text("Reload")
            }
        }

        AndroidView(
            factory = { ctx ->
                WebView(ctx).apply {
                    webViewClient = WebViewClient()
                    webChromeClient = WebChromeClient()

                    settings.apply {
                        javaScriptEnabled = true
                        domStorageEnabled = true
                        allowFileAccess = true
                        useWideViewPort = true
                        loadWithOverviewMode = true
                        mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                    }

                    activity?.let {
                        addJavascriptInterface(XIntentJSBridge(it), "XIntentNative")
                    }

                    loadUrl(cardUrl)
                    webViewRef = this
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
    }
}
