package com.globus.crm.feature.wallet.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.wallet.domain.model.GiftCard
import com.globus.crm.feature.wallet.domain.repository.GiftCardRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetGiftCardStorefrontUseCase @Inject constructor(
    private val repository: GiftCardRepository,
) {
    suspend operator fun invoke(): Result<List<GiftCard>> = try {
        Result.Success(repository.getStorefront())
    } catch (e: HttpException) {
        Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
