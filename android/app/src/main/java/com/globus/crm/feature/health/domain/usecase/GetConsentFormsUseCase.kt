package com.globus.crm.feature.health.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.model.ConsentForm
import com.globus.crm.feature.health.domain.repository.ConsentFormRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetConsentFormsUseCase @Inject constructor(
    private val repository: ConsentFormRepository,
) {
    suspend operator fun invoke(): Result<List<ConsentForm>> = try {
        Result.Success(repository.getConsentForms())
    } catch (e: IllegalStateException) {
        Result.Error("NO_PATIENT_ID", "Session error. Please log in again.")
    } catch (e: HttpException) {
        Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
