package com.furstfri.llmmobilebridge

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecurePairingStore(context: Context) {
    private val preferences = context.getSharedPreferences("bridge_pairing", Context.MODE_PRIVATE)
    private val keyAlias = "llm_mobile_bridge_pairing_key"

    fun save(payload: PairingPayload) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val cleartext = "${payload.url}\n${payload.token}".toByteArray(Charsets.UTF_8)
        preferences.edit {
            putString("ciphertext", Base64.encodeToString(cipher.doFinal(cleartext), Base64.NO_WRAP))
            putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        }
    }

    fun load(): PairingPayload? = runCatching {
        val encrypted = preferences.getString("ciphertext", null) ?: return null
        val iv = preferences.getString("iv", null) ?: return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
        )
        val value = String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), Charsets.UTF_8)
        val split = value.indexOf('\n')
        require(split > 0)
        PairingPayload(value.substring(0, split), value.substring(split + 1))
    }.getOrNull()

    fun clear() {
        preferences.edit { clear() }
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
