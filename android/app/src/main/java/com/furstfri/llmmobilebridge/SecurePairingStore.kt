package com.furstfri.llmmobilebridge

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Keystore-encrypted storage for every paired machine. */
class SecurePairingStore(context: Context) {
    private val preferences = context.getSharedPreferences("bridge_pairing", Context.MODE_PRIVATE)
    private val keyAlias = "llm_mobile_bridge_pairing_key"

    fun save(pairings: List<PairingPayload>) {
        val array = JSONArray()
        pairings.forEach { pairing ->
            array.put(
                JSONObject()
                    .put("id", pairing.id)
                    .put("url", pairing.url)
                    .put("token", pairing.token)
                    .put("name", pairing.name),
            )
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        preferences.edit {
            putString("hosts", Base64.encodeToString(
                cipher.doFinal(array.toString().toByteArray(Charsets.UTF_8)),
                Base64.NO_WRAP,
            ))
            putString("hosts_iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            // Drop the single-host format written by versions before 0.5.0.
            remove("ciphertext")
            remove("iv")
        }
    }

    fun load(): List<PairingPayload> = loadHosts() ?: loadLegacySingleHost() ?: emptyList()

    fun clear() {
        preferences.edit { clear() }
    }

    private fun loadHosts(): List<PairingPayload>? = runCatching {
        val encrypted = preferences.getString("hosts", null) ?: return null
        val iv = preferences.getString("hosts_iv", null) ?: return null
        val array = JSONArray(decrypt(encrypted, iv))
        buildList {
            for (index in 0 until array.length()) {
                val item = array.getJSONObject(index)
                add(PairingPayload(
                    url = item.getString("url"),
                    token = item.getString("token"),
                    name = item.optString("name", "Компьютер"),
                    id = item.optString("id").ifBlank { item.getString("token").hashCode().toString() },
                ))
            }
        }
    }.getOrNull()

    /** Reads the pre-0.5.0 "url\ntoken" blob so an update keeps the pairing. */
    private fun loadLegacySingleHost(): List<PairingPayload>? = runCatching {
        val encrypted = preferences.getString("ciphertext", null) ?: return null
        val iv = preferences.getString("iv", null) ?: return null
        val value = decrypt(encrypted, iv)
        val split = value.indexOf('\n')
        require(split > 0)
        listOf(PairingPayload(
            url = value.substring(0, split),
            token = value.substring(split + 1),
            name = "Компьютер",
        ))
    }.getOrNull()

    private fun decrypt(encrypted: String, iv: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
        )
        return String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), Charsets.UTF_8)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }
}
