package com.globus.crm.feature.health.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.model.Prescription
import com.globus.crm.feature.health.domain.repository.PrescriptionRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetPrescriptionsUseCase @Inject constructor(
    private val repository: PrescriptionRepository,
) {
    suspend operator fun invoke(): Result<List<Prescription>> = try {
        Result.Success(repository.getPrescriptions())
    } catch (e: HttpException) {
        Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        val cached = repository.getCachedPrescriptions()
        if (cached.isNotEmpty()) Result.Success(cached)
        else Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
