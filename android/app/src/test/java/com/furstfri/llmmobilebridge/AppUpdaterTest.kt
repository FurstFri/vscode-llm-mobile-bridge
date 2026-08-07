package com.furstfri.llmmobilebridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdaterTest {
    @Test
    fun comparesVersionsByComponentNotAsText() {
        // Lexicographic order would call 0.9.0 newer than 0.11.0.
        assertTrue(AppUpdater.isNewer("0.13.0", "0.12.0"))
        assertTrue(AppUpdater.isNewer("0.11.0", "0.9.0"))
        assertFalse(AppUpdater.isNewer("0.12.0", "0.12.0"))
        assertFalse(AppUpdater.isNewer("0.12.0", "0.13.0"))
        assertTrue(AppUpdater.isNewer("v1.0", "0.13.0"))
    }

    @Test
    fun picksTheApkAssetFromARelease() {
        val release = AppUpdater.parseRelease(JSONObject("""
            {
              "tag_name": "v0.13.0",
              "body": "release notes",
              "assets": [
                {"name": "llm-mobile-bridge.vsix", "browser_download_url": "https://example.com/a.vsix"},
                {"name": "llm-mobile-bridge-debug.apk", "browser_download_url": "https://example.com/a.apk"}
              ]
            }
        """.trimIndent()))

        assertEquals("0.13.0", release?.version)
        assertEquals("v0.13.0", release?.tag)
        assertEquals("https://example.com/a.apk", release?.downloadUrl)
    }

    @Test
    fun treatsAReleaseWithoutAnApkAsNotInstallable() {
        val release = AppUpdater.parseRelease(JSONObject("""
            {"tag_name": "v0.13.0", "assets": [{"name": "notes.txt", "browser_download_url": "https://example.com/n.txt"}]}
        """.trimIndent()))

        assertNull(release)
        assertNull(AppUpdater.parseRelease(JSONObject("""{"assets":[]}""")))
    }
}
