package com.globussoft.wellness.core.data.datastore

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.globussoft.wellness.core.domain.model.UserRole
import com.globussoft.wellness.core.domain.model.WellnessRole
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

/**
 * DataStore-backed persistent store for the authenticated user's session.
 *
 * All fields are stored as [String] preferences so the DataStore schema
 * stays flat and backward-compatible across app updates.
 *
 * [tokenFlow]  — hot [Flow] that emits the current JWT or null whenever the
 *                session changes; UI and repository layers can collect this
 *                to react to login/logout without polling.
 * [userFlow]   — hot [Flow] that reconstructs a full [UserSession] from all
 *                stored keys; emits null when no valid session is present.
 */
@Singleton
class AuthDataStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    // One DataStore instance per application context (preferencesDataStore is a
    // property delegate that creates the singleton lazily on first access).
    private val Context.dataStore: DataStore<Preferences>
            by preferencesDataStore(name = PREFS_NAME)

    companion object {
        private const val PREFS_NAME = "auth_prefs"

        val KEY_TOKEN         = stringPreferencesKey("access_token")
        val KEY_USER_ID       = stringPreferencesKey("user_id")
        val KEY_ROLE          = stringPreferencesKey("user_role")
        val KEY_WELLNESS_ROLE = stringPreferencesKey("wellness_role")
        val KEY_TENANT_ID     = stringPreferencesKey("tenant_id")
        val KEY_TENANT_NAME   = stringPreferencesKey("tenant_name")
        val KEY_USER_NAME     = stringPreferencesKey("user_name")
        val KEY_USER_EMAIL    = stringPreferencesKey("user_email")
        val KEY_VERTICAL      = stringPreferencesKey("vertical")
    }

    /** Emits the stored JWT string, or null if no session exists. */
    val tokenFlow: Flow<String?> = context.dataStore.data
        .map { prefs -> prefs[KEY_TOKEN] }

    /**
     * Emits a fully reconstructed [UserSession] from stored preferences,
     * or null when [KEY_TOKEN] is absent (i.e. the user is logged out).
     *
     * [UserRole.USER] is used as a safe fallback if the stored role string
     * cannot be parsed (e.g. after a schema migration).
     * [WellnessRole] is nullable — null is the correct value for generic-tenant users.
     */
    val userFlow: Flow<UserSession?> = context.dataStore.data
        .map { prefs ->
            val token = prefs[KEY_TOKEN] ?: return@map null
            UserSession(
                accessToken      = token,
                userId           = prefs[KEY_USER_ID] ?: "",
                email            = prefs[KEY_USER_EMAIL] ?: "",
                name             = prefs[KEY_USER_NAME] ?: "",
                role             = prefs[KEY_ROLE]
                    ?.let { runCatching { UserRole.valueOf(it) }.getOrDefault(UserRole.USER) }
                    ?: UserRole.USER,
                wellnessRole     = prefs[KEY_WELLNESS_ROLE]
                    ?.let { runCatching { WellnessRole.valueOf(it) }.getOrNull() },
                tenantId         = prefs[KEY_TENANT_ID] ?: "",
                tenantName       = prefs[KEY_TENANT_NAME] ?: "",
                vertical         = prefs[KEY_VERTICAL] ?: "wellness",
            )
        }

    /**
     * Persists all fields of [session] to DataStore in a single atomic write.
     * Also mirrors the token to SharedPreferences so the OkHttp AuthInterceptor
     * (which is synchronous and cannot read DataStore) can attach it.
     */
    suspend fun saveSession(session: UserSession) {
        context.dataStore.edit { prefs ->
            prefs[KEY_TOKEN]         = session.accessToken
            prefs[KEY_USER_ID]       = session.userId
            prefs[KEY_USER_EMAIL]    = session.email
            prefs[KEY_USER_NAME]     = session.name
            prefs[KEY_ROLE]          = session.role.name
            prefs[KEY_TENANT_ID]     = session.tenantId
            prefs[KEY_TENANT_NAME]   = session.tenantName
            prefs[KEY_VERTICAL]      = session.vertical
            if (session.wellnessRole != null) {
                prefs[KEY_WELLNESS_ROLE] = session.wellnessRole.name
            } else {
                prefs.remove(KEY_WELLNESS_ROLE)
            }
        }
        // Mirror token to SharedPreferences for the synchronous AuthInterceptor.
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString("access_token", session.accessToken)
            .apply()
    }

    /**
     * Removes all stored session data from both DataStore and SharedPreferences.
     */
    suspend fun clearSession() {
        context.dataStore.edit { it.clear() }
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove("access_token")
            .apply()
    }

    /**
     * One-shot read of the current token without subscribing to the flow.
     *
     * Prefer [tokenFlow] for reactive UI; use this in repository coroutines
     * where a single token read is sufficient.
     *
     * @return The stored JWT string, or null if no session exists.
     */
    suspend fun getToken(): String? =
        context.dataStore.data.first()[KEY_TOKEN]
}
