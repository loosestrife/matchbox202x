package org.xintent.flammenwerfer.core

import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object XIntentLogManager {
    private const val TAG = "XIntentClient"

    private val logListeners = mutableSetOf<() -> Unit>()
    private val logEntries = mutableListOf<String>()

    fun getLogHistory(): String {
        synchronized(logEntries) {
            return if (logEntries.isEmpty()) {
                "No requests dispatched yet."
            } else {
                logEntries.joinToString("\n----------------------------------------\n")
            }
        }
    }

    fun addLog(entry: String) {
        Log.i(TAG, entry)
        val timeStr = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        val formattedEntry = "[$timeStr] $entry"
        val listenersCopy: List<() -> Unit>
        synchronized(logEntries) {
            logEntries.add(0, formattedEntry)
            if (logEntries.size > 30) {
                logEntries.removeAt(logEntries.size - 1)
            }
        }
        synchronized(logListeners) {
            listenersCopy = logListeners.toList()
        }
        listenersCopy.forEach { it() }
    }

    fun addLogListener(listener: () -> Unit) {
        synchronized(logListeners) {
            logListeners.add(listener)
        }
    }

    fun removeLogListener(listener: () -> Unit) {
        synchronized(logListeners) {
            logListeners.remove(listener)
        }
    }
}
