package com.globus.crm.feature.health.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.repository.ConsentFormRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetConsentFormPdfUseCase @Inject constructor(
    private val repository: ConsentFormRepository,
) {
    suspend operator fun invoke(consentId: Int): Result<ByteArray> = try {
        Result.Success(repository.getConsentFormPdf(consentId))
    } catch (e: HttpException) {
        Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
