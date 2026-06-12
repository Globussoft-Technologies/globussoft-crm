package com.globus.crm.feature.health.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.model.TreatmentPlan
import com.globus.crm.feature.health.domain.repository.TreatmentPlanRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetTreatmentPlansUseCase @Inject constructor(
    private val repository: TreatmentPlanRepository,
) {
    suspend operator fun invoke(): Result<List<TreatmentPlan>> = try {
        Result.Success(repository.getTreatmentPlans())
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
