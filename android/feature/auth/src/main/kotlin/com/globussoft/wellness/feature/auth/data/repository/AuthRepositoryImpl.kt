package com.globussoft.wellness.feature.auth.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.datastore.AuthDataStore
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.core.domain.model.UserRole
import com.globussoft.wellness.core.domain.model.WellnessRole
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.model.request.LoginRequest
import com.globussoft.wellness.core.network.util.safeApiCall
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Contract for authentication operations.
 *
 * Implemented by [AuthRepositoryImpl]; the interface exists so Hilt can inject
 * the implementation via [com.globussoft.wellness.feature.auth.di.AuthModule]
 * and tests can substitute a fake.
 */
interface AuthRepository {

    /**
     * Authenticates the user with the server.
     *
     * On success the session is persisted via [AuthDataStore] so the app
     * survives process death without re-login.
     *
     * @return [WResult.Success] containing the stored [UserSession], or
     *         [WResult.Error] describing the failure.
     */
    suspend fun login(email: String, password: String): WResult<UserSession>

    /**
     * Clears the stored session from [AuthDataStore] and signs the user out.
     *
     * The caller is responsible for navigating to the login screen afterwards.
     */
    suspend fun logout()
}

/**
 * Production implementation of [AuthRepository].
 *
 * [WellnessApi.login] is called via [safeApiCall] so network failures and
 * non-2xx responses are automatically mapped to typed [WResult.Error] variants
 * before crossing into the domain layer.
 */
@Singleton
class AuthRepositoryImpl @Inject constructor(
    private val api: WellnessApi,
    private val authDataStore: AuthDataStore,
) : AuthRepository {

    override suspend fun login(email: String, password: String): WResult<UserSession> {
        val result = safeApiCall {
            api.login(LoginRequest(email = email, password = password))
        }

        return when (result) {
            is WResult.Success -> {
                val response = result.data
                val user = response.user
                val tenant = response.tenant

                // Map server-returned role strings to typed enums with safe fallbacks.
                val userRole = runCatching { UserRole.valueOf(user.role.uppercase()) }
                    .getOrDefault(UserRole.USER)
                val wellnessRole = user.wellnessRole
                    ?.let { runCatching { WellnessRole.valueOf(it.uppercase()) }.getOrNull() }

                val session = UserSession(
                    accessToken  = response.token,
                    userId       = user.id.toString(),
                    email        = user.email,
                    name         = user.name,
                    role         = userRole,
                    wellnessRole = wellnessRole,
                    tenantId     = tenant.id.toString(),
                    tenantName   = tenant.name,
                    vertical     = tenant.vertical,
                )

                authDataStore.saveSession(session)
                WResult.Success(session)
            }

            is WResult.Error -> result

            WResult.Loading -> result as WResult<UserSession>
        }
    }

    override suspend fun logout() {
        authDataStore.clearSession()
    }
}
