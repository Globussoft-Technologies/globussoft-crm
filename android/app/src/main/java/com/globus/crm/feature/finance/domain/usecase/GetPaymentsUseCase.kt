package com.globus.crm.feature.finance.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.finance.domain.model.Payment
import com.globus.crm.feature.finance.domain.repository.FinanceRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetPaymentsUseCase @Inject constructor(
    private val repository: FinanceRepository,
) {
    suspend operator fun invoke(): Result<List<Payment>> = try {
        Result.Success(repository.getPayments())
    } catch (e: HttpException) {
        if (e.code() == 401) Result.Error("UNAUTHORIZED", "Session expired", 401)
        else Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
