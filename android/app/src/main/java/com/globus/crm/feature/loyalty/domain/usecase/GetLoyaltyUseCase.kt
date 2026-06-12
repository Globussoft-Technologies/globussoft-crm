package com.globus.crm.feature.loyalty.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.loyalty.domain.model.LoyaltyData
import com.globus.crm.feature.loyalty.domain.repository.LoyaltyRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetLoyaltyUseCase @Inject constructor(
    private val repository: LoyaltyRepository,
) {
    suspend operator fun invoke(): Result<LoyaltyData> = try {
        Result.Success(repository.getLoyalty())
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
