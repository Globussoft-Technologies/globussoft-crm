package com.globus.crm.core.storage

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class DataStoreManager @Inject constructor(
    private val dataStore: DataStore<Preferences>,
) {
    companion object {
        val KEY_JWT = stringPreferencesKey("portal_jwt")
        val KEY_BRAND_COLOR = stringPreferencesKey("tenant_brand_color")
        val KEY_CLINIC_NAME = stringPreferencesKey("tenant_clinic_name")
        val KEY_CLINIC_LOGO = stringPreferencesKey("tenant_clinic_logo_url")
        val KEY_TENANT_ID = intPreferencesKey("tenant_id")
        val KEY_DARK_THEME = booleanPreferencesKey("dark_theme")
    }

    suspend fun saveToken(token: String) {
        dataStore.edit { it[KEY_JWT] = token }
    }

    suspend fun getToken(): String? =
        dataStore.data.map { it[KEY_JWT] }.firstOrNull()

    fun tokenFlow() = dataStore.data.map { it[KEY_JWT] }

    suspend fun clearAll() {
        dataStore.edit { it.clear() }
    }

    suspend fun saveTenantBranding(brandColor: String, clinicName: String, logoUrl: String?) {
        dataStore.edit { prefs ->
            prefs[KEY_BRAND_COLOR] = brandColor
            prefs[KEY_CLINIC_NAME] = clinicName
            if (logoUrl != null) prefs[KEY_CLINIC_LOGO] = logoUrl
        }
    }

    suspend fun getBrandColor(): String? =
        dataStore.data.map { it[KEY_BRAND_COLOR] }.firstOrNull()

    suspend fun getClinicName(): String? =
        dataStore.data.map { it[KEY_CLINIC_NAME] }.firstOrNull()

    suspend fun saveTenantId(tenantId: Int) {
        dataStore.edit { it[KEY_TENANT_ID] = tenantId }
    }

    suspend fun getTenantId(): Int? =
        dataStore.data.map { it[KEY_TENANT_ID] }.firstOrNull()

    fun isDarkThemeFlow() = dataStore.data.map { it[KEY_DARK_THEME] ?: false }

    fun clinicNameFlow() = dataStore.data.map { it[KEY_CLINIC_NAME] ?: "" }

    suspend fun setDarkTheme(enabled: Boolean) {
        dataStore.edit { it[KEY_DARK_THEME] = enabled }
    }
}
