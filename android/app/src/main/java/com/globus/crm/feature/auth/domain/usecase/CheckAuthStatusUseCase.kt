package com.globus.crm.feature.auth.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.repository.AuthRepository
import java.io.IOException
import javax.inject.Inject

class CheckAuthStatusUseCase @Inject constructor(
    private val repository: AuthRepository,
) {
    suspend operator fun invoke(): Result<Boolean> = try {
        Result.Success(repository.hasValidToken())
    } catch (e: IOException) {
        Result.Error("STORAGE_ERROR", "Failed to read auth state")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
