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
    private const val KEY_TTS_TARGET_APP = "tts_target_app"

    const val DEFAULT_SERVER_URL = "http://10.0.2.2:12345"
    const val DEFAULT_HOSTNAME = "user-phone"
    const val DEFAULT_UDP_PORT = 12346
    const val DEFAULT_REMOTE_DEVICE = "user-desktop"

    private fun getString(context: Context, key: String, default: String): String =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(key, default).orEmpty().ifBlank { default }

    private fun setString(context: Context, key: String, value: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(key, value.trim()).apply()
    }

    private fun getBoolean(context: Context, key: String, default: Boolean): Boolean =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getBoolean(key, default)

    private fun setBoolean(context: Context, key: String, value: Boolean) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putBoolean(key, value).apply()
    }

    private fun getRoutingMode(
        context: Context,
        modeKey: String,
        legacyBoolKey: String,
        legacyDefault: Boolean,
        localModeName: String,
    ): String {
        val fallback = if (getBoolean(context, legacyBoolKey, legacyDefault)) localModeName else "normal"
        return getString(context, modeKey, fallback)
    }

    fun getServerUrl(context: Context): String =
        getString(context, KEY_SERVER_URL, DEFAULT_SERVER_URL)

    fun setServerUrl(context: Context, url: String) =
        setString(context, KEY_SERVER_URL, url.trim().removeSuffix("/"))

    fun getHostname(context: Context): String =
        getString(context, KEY_HOSTNAME, DEFAULT_HOSTNAME)

    fun setHostname(context: Context, hostname: String) =
        setString(context, KEY_HOSTNAME, hostname)

    fun getAdvertisedName(context: Context): String =
        "${getHostname(context)}:flammenwerfer"

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

    fun getUdpPort(context: Context): Int =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getInt(KEY_UDP_PORT, DEFAULT_UDP_PORT)

    fun setUdpPort(context: Context, port: Int) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putInt(KEY_UDP_PORT, port).apply()
    }

    fun getDefaultRemoteDevice(context: Context): String =
        getString(context, KEY_DEFAULT_REMOTE_DEVICE, DEFAULT_REMOTE_DEVICE)

    fun setDefaultRemoteDevice(context: Context, device: String) =
        setString(context, KEY_DEFAULT_REMOTE_DEVICE, device.ifBlank { DEFAULT_REMOTE_DEVICE })

    fun getAudioRoutingMode(context: Context): String =
        getRoutingMode(context, KEY_AUDIO_ROUTING_MODE, KEY_LOCAL_AUDIO, true, "doLocalAudioCapture")

    fun setAudioRoutingMode(context: Context, mode: String) =
        setString(context, KEY_AUDIO_ROUTING_MODE, mode)

    fun getTtsRoutingMode(context: Context): String =
        getRoutingMode(context, KEY_TTS_ROUTING_MODE, KEY_LOCAL_TTS, false, "doLocalTtsCapture")

    fun setTtsRoutingMode(context: Context, mode: String) =
        setString(context, KEY_TTS_ROUTING_MODE, mode)

    fun getClipboardRoutingMode(context: Context): String =
        getRoutingMode(context, KEY_CLIPBOARD_ROUTING_MODE, KEY_LOCAL_CLIPBOARD, false, "doLocalClipboardCapture")

    fun setClipboardRoutingMode(context: Context, mode: String) =
        setString(context, KEY_CLIPBOARD_ROUTING_MODE, mode)

    fun getFsRoutingMode(context: Context): String =
        getRoutingMode(context, KEY_FS_ROUTING_MODE, KEY_LOCAL_FS, false, "doLocalFsCapture")

    fun setFsRoutingMode(context: Context, mode: String) =
        setString(context, KEY_FS_ROUTING_MODE, mode)

    fun isLocalAudioEnabled(context: Context): Boolean =
        getAudioRoutingMode(context) == "doLocalAudioCapture"

    fun isLocalTtsEnabled(context: Context): Boolean =
        getTtsRoutingMode(context) == "doLocalTtsCapture"

    fun getTargetApp(context: Context, actionIndex: Int): String =
        getString(context, "target_app_action_$actionIndex", if (actionIndex == 2) "cool-bible" else "cool-clips")

    fun setTargetApp(context: Context, actionIndex: Int, appName: String) =
        setString(context, "target_app_action_$actionIndex", appName)

    fun getTtsTargetApp(context: Context): String =
        getString(context, KEY_TTS_TARGET_APP, "cool-tts")

    fun setTtsTargetApp(context: Context, appName: String) =
        setString(context, KEY_TTS_TARGET_APP, appName)
}
