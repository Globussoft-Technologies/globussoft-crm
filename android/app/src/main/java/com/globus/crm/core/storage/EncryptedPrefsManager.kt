package com.globus.crm.core.storage

import android.content.SharedPreferences
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

@Singleton
class EncryptedPrefsManager @Inject constructor(
    @Named("encrypted") private val prefs: SharedPreferences,
) {
    companion object {
        private const val KEY_USER_ID = "user_id"
        private const val KEY_USER_NAME = "user_name"
        private const val KEY_USER_EMAIL = "user_email"
        private const val KEY_PATIENT_ID = "patient_id"
    }

    fun saveUserInfo(userId: Int, name: String, email: String) {
        prefs.edit()
            .putInt(KEY_USER_ID, userId)
            .putString(KEY_USER_NAME, name)
            .putString(KEY_USER_EMAIL, email)
            .apply()
    }

    fun savePatientId(patientId: Int) {
        prefs.edit().putInt(KEY_PATIENT_ID, patientId).apply()
    }

    fun getUserId(): Int = prefs.getInt(KEY_USER_ID, -1)

    fun getUserName(): String? = prefs.getString(KEY_USER_NAME, null)

    fun getUserEmail(): String? = prefs.getString(KEY_USER_EMAIL, null)

    // patientId is fetched from GET /portal/me after login and cached here.
    // Required for loyalty/{patientId}, patients/{patientId}/wallet, etc.
    fun getPatientId(): Int? = prefs.getInt(KEY_PATIENT_ID, -1).takeIf { it != -1 }

    fun clear() {
        prefs.edit().clear().apply()
    }
}
