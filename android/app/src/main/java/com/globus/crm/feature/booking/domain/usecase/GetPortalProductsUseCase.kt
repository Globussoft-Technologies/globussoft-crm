package com.globus.crm.feature.booking.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.booking.domain.model.Product
import com.globus.crm.feature.booking.domain.repository.AppointmentRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetPortalProductsUseCase @Inject constructor(
    private val repository: AppointmentRepository,
) {
    suspend operator fun invoke(): Result<List<Product>> = try {
        Result.Success(repository.getPortalProducts().distinctBy { it.name })
    } catch (e: HttpException) {
        Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
