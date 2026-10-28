package org.xintent.flammenwerfer

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.xintent.flammenwerfer.config.XIntentPreferences

class ProcessTextActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (intent?.action != Intent.ACTION_PROCESS_TEXT) {
            finish()
            return
        }

        val selectedText = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString().orEmpty()
        if (selectedText.isBlank()) {
            Toast.makeText(this, "No text selected", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        val canReplace = !intent.getBooleanExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, false)
        val className = intent.component?.className.orEmpty()
        val actionIndex = when {
            className.endsWith("ProcessTextAction2") -> 2
            className.endsWith("ProcessTextAction3") -> 3
            else -> 1
        }
        val targetApp = XIntentPreferences.getTargetApp(applicationContext, actionIndex)
        Toast.makeText(applicationContext, "Sending to $targetApp...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            val result = XIntentDispatcher.sendTextProcessIntent(
                context = applicationContext,
                text = selectedText,
                targetApp = targetApp,
                canReplace = canReplace,
            )
            handleProcessResult(result, canReplace, targetApp)
            finish()
        }
    }

    private fun handleProcessResult(result: XIntentClient.Result, canReplace: Boolean, targetApp: String) {
        if (!result.success) {
            Toast.makeText(applicationContext, "Failed sending to $targetApp: ${result.errorMessage}", Toast.LENGTH_LONG).show()
            return
        }
        if (canReplace && result.replacementText.isNotBlank()) {
            val resultIntent = Intent().putExtra(Intent.EXTRA_PROCESS_TEXT, result.replacementText)
            setResult(RESULT_OK, resultIntent)
            Toast.makeText(applicationContext, "Text replaced by $targetApp!", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(applicationContext, "Sent to $targetApp successfully!", Toast.LENGTH_SHORT).show()
        }
    }
}
