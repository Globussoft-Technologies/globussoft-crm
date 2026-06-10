package com.globus.crm.core.network

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TokenManager @Inject constructor(
    private val dataStore: DataStore<Preferences>,
) {
    companion object {
        private val KEY_TOKEN = stringPreferencesKey("portal_jwt")
    }

    suspend fun getToken(): String? =
        dataStore.data.map { it[KEY_TOKEN] }.firstOrNull()

    suspend fun saveToken(token: String) {
        dataStore.edit { it[KEY_TOKEN] = token }
    }

    suspend fun clearToken() {
        dataStore.edit { it.remove(KEY_TOKEN) }
    }

    fun tokenFlow() = dataStore.data.map { it[KEY_TOKEN] }
}
