package com.globus.crm.feature.auth.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.model.TenantBranding
import com.globus.crm.feature.auth.domain.repository.AuthRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetTenantBrandingUseCase @Inject constructor(
    private val repository: AuthRepository,
) {
    suspend operator fun invoke(slug: String): Result<TenantBranding> = try {
        Result.Success(repository.getTenantBranding(slug))
    } catch (e: HttpException) {
        Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
