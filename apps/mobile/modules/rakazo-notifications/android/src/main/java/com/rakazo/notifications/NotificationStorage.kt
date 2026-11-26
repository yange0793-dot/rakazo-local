package com.rakazo.notifications

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class NotificationSettings(
  val liveConnection: Boolean = false,
  val messages: Boolean = true,
  val scheduledTasks: Boolean = true,
  val needsAttention: Boolean = true,
) {
  fun toMap() = mapOf(
    "liveConnection" to liveConnection,
    "messages" to messages,
    "scheduledTasks" to scheduledTasks,
    "needsAttention" to needsAttention,
  )

  companion object {
    fun fromMap(value: Map<String, Boolean>) = NotificationSettings(
      liveConnection = value["liveConnection"] ?: false,
      messages = value["messages"] ?: true,
      scheduledTasks = value["scheduledTasks"] ?: true,
      needsAttention = value["needsAttention"] ?: true,
    )
  }
}

internal class NotificationStorage(context: Context) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  var settings: NotificationSettings
    get() = NotificationSettings(
      liveConnection = preferences.getBoolean(LIVE, false),
      messages = preferences.getBoolean(MESSAGES, true),
      scheduledTasks = preferences.getBoolean(SCHEDULED, true),
      needsAttention = preferences.getBoolean(ATTENTION, true),
    )
    set(value) = commit {
      putBoolean(LIVE, value.liveConnection)
      putBoolean(MESSAGES, value.messages)
      putBoolean(SCHEDULED, value.scheduledTasks)
      putBoolean(ATTENTION, value.needsAttention)
    }

  val locale: String
    get() = preferences.getString(LOCALE, "").orEmpty()

  val token: String
    get() = decrypt(preferences.getString(TOKEN, null))

  inner class Connection(private val values: Map<String, *>) {
    val endpoint = values[ENDPOINT] as? String ?: ""
    val spaceId = values[SPACE_ID] as? String ?: ""
    val locale = values[LOCALE] as? String ?: ""
    val encodedToken = values[TOKEN] as? String
    val token: String get() = decrypt(encodedToken)
    val headers: String by lazy { decrypt(values[HEADERS] as? String) }
  }

  /** Endpoint and credentials come from one preferences snapshot. */
  fun connection() = Connection(preferences.all)

  fun saveConnection(
    endpoint: String,
    token: String,
    headers: String,
    spaceId: String? = null,
    locale: String? = null,
  ) = commit {
    putString(ENDPOINT, endpoint)
    putString(TOKEN, encrypt(token))
    putString(HEADERS, encrypt(headers))
    if (spaceId != null) putString(SPACE_ID, spaceId)
    if (locale != null) putString(LOCALE, locale)
  }

  fun clearConnection() = commit {
    remove(TOKEN)
    remove(HEADERS)
    remove(SPACE_ID)
  }

  private fun decrypt(encoded: String?): String {
    if (encoded == null) return ""
    return runCatching {
      val bytes = Base64.decode(encoded, Base64.NO_WRAP)
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_SIZE))
      String(cipher.doFinal(bytes, IV_SIZE, bytes.size - IV_SIZE), Charsets.UTF_8)
    }.getOrDefault("")
  }

  private fun encrypt(value: String): String? {
    if (value.isEmpty()) return null
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val encrypted = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(encrypted, Base64.NO_WRAP)
  }

  private fun key(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(
        KeyGenParameterSpec.Builder(
          KEY_ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build(),
      )
      generateKey()
    }
  }

  private fun commit(change: android.content.SharedPreferences.Editor.() -> Unit) {
    check(preferences.edit().apply(change).commit()) { "Could not save notification settings" }
  }

  private companion object {
    const val PREFERENCES = "com.rakazo.notifications"
    const val LIVE = "live_connection"
    const val MESSAGES = "messages"
    const val SCHEDULED = "scheduled_tasks"
    const val ATTENTION = "needs_attention"
    const val ENDPOINT = "endpoint"
    const val SPACE_ID = "space_id"
    const val LOCALE = "locale"
    const val TOKEN = "token"
    const val HEADERS = "server_headers"
    const val KEY_ALIAS = "rakazo.notifications.session"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_SIZE = 12
  }
}
