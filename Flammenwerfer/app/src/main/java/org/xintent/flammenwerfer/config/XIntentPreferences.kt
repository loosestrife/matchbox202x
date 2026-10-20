package org.xintent.flammenwerfer.config

import android.content.Context

object XIntentPreferences {
    private const val PREFS_NAME = "xintent_prefs"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_HOSTNAME = "hostname"
    private const val KEY_UDP_PORT = "udp_wake_port"
    private const val KEY_LOCAL_FS = "use_local_fs"
    private const val KEY_LOCAL_CLIPBOARD = "use_local_clipboard"
    private const val KEY_LOCAL_TTS = "use_local_tts"
    private const val KEY_LOCAL_AUDIO = "use_local_audio"
    private const val KEY_DEFAULT_REMOTE_DEVICE = "default_remote_device"
    private const val KEY_AUDIO_ROUTING_MODE = "audio_routing_mode"
    private const val KEY_TTS_ROUTING_MODE = "tts_routing_mode"
    private const val KEY_CLIPBOARD_ROUTING_MODE = "clipboard_routing_mode"
    private const val KEY_FS_ROUTING_MODE = "fs_routing_mode"

    const val DEFAULT_SERVER_URL = "http://10.0.2.2:12345"
    const val DEFAULT_HOSTNAME = "user-phone"
    const val DEFAULT_UDP_PORT = 12346
    const val DEFAULT_REMOTE_DEVICE = "user-desktop"

    fun getServerUrl(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
    }

    fun setServerUrl(context: Context, url: String) {
        val cleanUrl = url.trim().removeSuffix("/")
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_SERVER_URL, cleanUrl).apply()
    }

    fun getHostname(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_HOSTNAME, DEFAULT_HOSTNAME) ?: DEFAULT_HOSTNAME
        return saved.ifBlank { DEFAULT_HOSTNAME }
    }

    fun setHostname(context: Context, hostname: String) {
        val cleanHostname = hostname.trim()
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_HOSTNAME, cleanHostname).apply()
    }

    fun getAdvertisedName(context: Context): String {
        val host = getHostname(context)
        return "$host:flammenwerfer"
    }

    fun getManifest(context: Context): String {
        val advertisedName = getAdvertisedName(context)
        return """[app]
id = "$advertisedName"

[intents]
"ui.Copy" = true
"ui.Paste" = true
"ui.TextToSpeech" = true
"fs.PickFile" = true
"fs.SendTo" = true
"fs.SaveAs" = true

[XAudioSink]
name = "$advertisedName"
"""
    }

    fun getUdpPort(context: Context): Int {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getInt(KEY_UDP_PORT, DEFAULT_UDP_PORT)
    }

    fun setUdpPort(context: Context, port: Int) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putInt(KEY_UDP_PORT, port).apply()
    }

    fun getDefaultRemoteDevice(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_DEFAULT_REMOTE_DEVICE, DEFAULT_REMOTE_DEVICE) ?: DEFAULT_REMOTE_DEVICE
    }

    fun setDefaultRemoteDevice(context: Context, device: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_DEFAULT_REMOTE_DEVICE, device.ifBlank { DEFAULT_REMOTE_DEVICE }).apply()
    }

    fun getAudioRoutingMode(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_AUDIO_ROUTING_MODE, null)
        if (saved != null) return saved
        return if (prefs.getBoolean(KEY_LOCAL_AUDIO, true)) "doLocalAudioCapture" else "normal"
    }

    fun setAudioRoutingMode(context: Context, mode: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_AUDIO_ROUTING_MODE, mode).apply()
    }

    fun getTtsRoutingMode(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_TTS_ROUTING_MODE, null)
        if (saved != null) return saved
        return if (prefs.getBoolean(KEY_LOCAL_TTS, false)) "doLocalTtsCapture" else "normal"
    }

    fun setTtsRoutingMode(context: Context, mode: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_TTS_ROUTING_MODE, mode).apply()
    }

    fun getClipboardRoutingMode(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_CLIPBOARD_ROUTING_MODE, null)
        if (saved != null) return saved
        return if (prefs.getBoolean(KEY_LOCAL_CLIPBOARD, false)) "doLocalClipboardCapture" else "normal"
    }

    fun setClipboardRoutingMode(context: Context, mode: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_CLIPBOARD_ROUTING_MODE, mode).apply()
    }

    fun getFsRoutingMode(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_FS_ROUTING_MODE, null)
        if (saved != null) return saved
        return if (prefs.getBoolean(KEY_LOCAL_FS, false)) "doLocalFsCapture" else "normal"
    }

    fun setFsRoutingMode(context: Context, mode: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_FS_ROUTING_MODE, mode).apply()
    }

    fun isLocalAudioEnabled(context: Context): Boolean {
        return getAudioRoutingMode(context) == "doLocalAudioCapture"
    }

    fun setLocalAudioEnabled(context: Context, enabled: Boolean) {
        setAudioRoutingMode(context, if (enabled) "doLocalAudioCapture" else "normal")
    }

    fun isLocalTtsEnabled(context: Context): Boolean {
        return getTtsRoutingMode(context) == "doLocalTtsCapture"
    }

    fun setLocalTtsEnabled(context: Context, enabled: Boolean) {
        setTtsRoutingMode(context, if (enabled) "doLocalTtsCapture" else "normal")
    }

    fun isLocalClipboardEnabled(context: Context): Boolean {
        return getClipboardRoutingMode(context) == "doLocalClipboardCapture"
    }

    fun setLocalClipboardEnabled(context: Context, enabled: Boolean) {
        setClipboardRoutingMode(context, if (enabled) "doLocalClipboardCapture" else "normal")
    }

    fun isLocalFsEnabled(context: Context): Boolean {
        return getFsRoutingMode(context) == "doLocalFsCapture"
    }

    fun setLocalFsEnabled(context: Context, enabled: Boolean) {
        setFsRoutingMode(context, if (enabled) "doLocalFsCapture" else "normal")
    }

    fun getTargetApp(context: Context, actionIndex: Int): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val defaultApp = when (actionIndex) {
            1 -> "cool-clips"
            2 -> "cool-bible"
            3 -> "cool-clips"
            else -> "cool-clips"
        }
        return prefs.getString("target_app_action_$actionIndex", defaultApp) ?: defaultApp
    }

    fun setTargetApp(context: Context, actionIndex: Int, appName: String) {
        val cleanApp = appName.trim()
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString("target_app_action_$actionIndex", cleanApp).apply()
    }

    fun getTtsTargetApp(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString("tts_target_app", "cool-tts") ?: "cool-tts"
    }

    fun setTtsTargetApp(context: Context, appName: String) {
        val cleanApp = appName.trim()
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString("tts_target_app", cleanApp).apply()
    }
}
