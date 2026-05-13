package com.globussoft.wellness.feature.auth.domain.usecase

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.core.domain.usecase.UseCase
import com.globussoft.wellness.feature.auth.data.repository.AuthRepository
import javax.inject.Inject

/**
 * Use case that delegates login to [AuthRepository] and returns the resulting
 * [UserSession] wrapped in a [WResult].
 *
 * The single-responsibility boundary here is intentional: validation lives in
 * the ViewModel (presentation rule); the use case is a pure data-layer bridge.
 */
class LoginUseCase @Inject constructor(
    private val authRepository: AuthRepository,
) : UseCase<LoginParams, WResult<UserSession>>() {

    override suspend fun execute(params: LoginParams): WResult<UserSession> =
        authRepository.login(params.email, params.password)
}

/**
 * Input parameters for [LoginUseCase].
 *
 * @param email    The user's email address.
 * @param password The user's plain-text password (transmitted over HTTPS only).
 */
data class LoginParams(
    val email: String,
    val password: String,
)
