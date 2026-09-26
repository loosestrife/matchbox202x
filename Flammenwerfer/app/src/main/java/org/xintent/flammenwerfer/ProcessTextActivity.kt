package org.xintent.flammenwerfer

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class ProcessTextActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (intent?.action == Intent.ACTION_PROCESS_TEXT) {
            val selectedText = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString() ?: ""
            val isReadOnly = intent.getBooleanExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, false)
            val canReplace = !isReadOnly
            val className = intent.component?.className ?: ""

            val actionIndex = when {
                className.endsWith("ProcessTextAction1") -> 1
                className.endsWith("ProcessTextAction2") -> 2
                className.endsWith("ProcessTextAction3") -> 3
                else -> 1
            }

            val targetApp = XIntentClient.getTargetApp(applicationContext, actionIndex)

            if (selectedText.isNotBlank()) {
                // Show immediate feedback to user
                Toast.makeText(
                    applicationContext,
                    "Sending to $targetApp...",
                    Toast.LENGTH_SHORT,
                ).show()

                // Dispatch intent asynchronously
                lifecycleScope.launch {
                    val result = XIntentClient.sendTextProcessIntent(
                        context = applicationContext,
                        text = selectedText,
                        targetApp = targetApp,
                        canReplace = canReplace,
                    )

                    if (result.success && canReplace && !result.replacementText.isNullOrBlank()) {
                        val resultIntent = Intent().apply {
                            putExtra(Intent.EXTRA_PROCESS_TEXT, result.replacementText)
                        }
                        setResult(RESULT_OK, resultIntent)
                        Toast.makeText(applicationContext, "Text replaced by $targetApp!", Toast.LENGTH_SHORT).show()
                    } else if (result.success) {
                        Toast.makeText(applicationContext, "Sent to $targetApp successfully!", Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(applicationContext, "Failed sending to $targetApp: ${result.errorMessage}", Toast.LENGTH_LONG).show()
                    }

                    finish()
                }
            } else {
                Toast.makeText(this, "No text selected", Toast.LENGTH_SHORT).show()
                finish()
            }
        } else {
            finish()
        }
    }
}
