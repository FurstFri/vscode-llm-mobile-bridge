package com.furstfri.llmmobilebridge

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

data class AppRelease(
    val version: String,
    val tag: String,
    val downloadUrl: String,
    val notes: String,
)

/**
 * Checks GitHub Releases for a newer APK and hands it to the platform
 * installer. The app is distributed outside a store, so without this the only
 * way to update is to fetch the APK by hand.
 */
class AppUpdater(context: Context) {
    private val appContext = context.applicationContext
    private val http = OkHttpClient.Builder()
        .callTimeout(90, TimeUnit.SECONDS)
        .build()

    /** Calls back with the release only when it is newer than [currentVersion]. */
    fun check(currentVersion: String, onResult: (AppRelease?) -> Unit, onError: (String) -> Unit) {
        val request = Request.Builder()
            .url(LATEST_RELEASE_URL)
            .header("Accept", "application/vnd.github+json")
            .build()
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                onError(e.message ?: "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ ÑÐ²ÑÐ·Ð°Ñ‚ÑŒÑÑ Ñ GitHub")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { result ->
                    val body = result.body?.string()
                    if (!result.isSuccessful || body.isNullOrBlank()) {
                        onError("GitHub Ð¾Ñ‚Ð²ÐµÑ‚Ð¸Ð» ${result.code}")
                        return
                    }
                    val release = runCatching { parseRelease(JSONObject(body)) }.getOrNull()
                    if (release == null) {
                        onError("Ð’ Ð¿Ð¾ÑÐ»ÐµÐ´Ð½ÐµÐ¼ Ñ€ÐµÐ»Ð¸Ð·Ðµ Ð½ÐµÑ‚ APK")
                        return
                    }
                    onResult(if (isNewer(release.version, currentVersion)) release else null)
                }
            }
        })
    }

    fun download(release: AppRelease, onDone: (File) -> Unit, onError: (String) -> Unit) {
        val directory = File(appContext.cacheDir, "updates")
        directory.mkdirs()
        val target = File(directory, "llm-mobile-bridge-${release.tag}.apk")
        val request = Request.Builder().url(release.downloadUrl).build()
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                onError(e.message ?: "Ð¡ÐºÐ°Ñ‡Ð¸Ð²Ð°Ð½Ð¸Ðµ Ð½Ðµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { result ->
                    val body = result.body
                    if (!result.isSuccessful || body == null) {
                        onError("Ð¡ÐºÐ°Ñ‡Ð¸Ð²Ð°Ð½Ð¸Ðµ Ð½Ðµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ (${result.code})")
                        return
                    }
                    val saved = runCatching {
                        target.outputStream().use { output -> body.byteStream().copyTo(output) }
                    }
                    saved.onFailure { error ->
                        onError(error.message ?: "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ ÑÐ¾Ñ…Ñ€Ð°Ð½Ð¸Ñ‚ÑŒ Ñ„Ð°Ð¹Ð»")
                        return
                    }
                    onDone(target)
                }
            }
        })
    }

    /**
     * Launches the system installer. Returns false when Android still has to
     * grant this app the right to install packages, so the caller can send the
     * user to that settings screen instead of failing silently.
     */
    fun install(file: File): Boolean {
        if (!canInstall()) return false
        val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.updates", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        appContext.startActivity(intent)
        return true
    }

    fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || appContext.packageManager.canRequestPackageInstalls()

    fun requestInstallPermission() {
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${appContext.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        appContext.startActivity(intent)
    }

    companion object {
        const val LATEST_RELEASE_URL =
            "https://api.github.com/repos/FurstFri/vscode-llm-mobile-bridge/releases/latest"

        /** Picks the first APK asset; a release without one is not installable. */
        fun parseRelease(json: JSONObject): AppRelease? {
            val tag = json.optString("tag_name")
            if (tag.isBlank()) return null
            val assets = json.optJSONArray("assets") ?: return null
            for (index in 0 until assets.length()) {
                val asset = assets.optJSONObject(index) ?: continue
                if (!asset.optString("name").endsWith(".apk", ignoreCase = true)) continue
                val url = asset.optString("browser_download_url")
                if (url.isBlank()) continue
                return AppRelease(
                    version = tag.removePrefix("v"),
                    tag = tag,
                    downloadUrl = url,
                    notes = json.optString("body"),
                )
            }
            return null
        }

        /** Numeric component comparison, so 0.11.0 correctly beats 0.9.0. */
        fun isNewer(candidate: String, current: String): Boolean {
            val left = versionParts(candidate)
            val right = versionParts(current)
            for (index in 0 until maxOf(left.size, right.size)) {
                val a = left.getOrElse(index) { 0 }
                val b = right.getOrElse(index) { 0 }
                if (a != b) return a > b
            }
            return false
        }

        private fun versionParts(value: String): List<Int> =
            value.trim()
                .removePrefix("v")
                .split(".", "-", "+")
                .mapNotNull { part -> part.takeWhile(Char::isDigit).toIntOrNull() }
    }
}

