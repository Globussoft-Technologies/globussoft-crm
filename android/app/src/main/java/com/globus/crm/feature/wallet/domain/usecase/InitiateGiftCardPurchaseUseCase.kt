package com.globus.crm.feature.wallet.domain.usecase

import com.globus.crm.core.storage.EncryptedPrefsManager
import com.globus.crm.core.util.Result
import com.globus.crm.feature.wallet.domain.model.GiftCardOrder
import com.globus.crm.feature.wallet.domain.repository.GiftCardRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class InitiateGiftCardPurchaseUseCase @Inject constructor(
    private val repository: GiftCardRepository,
    private val encryptedPrefs: EncryptedPrefsManager,
) {
    suspend operator fun invoke(giftCardId: Int): Result<GiftCardOrder> = try {
        val patientId = encryptedPrefs.getPatientId() ?: -1
        Result.Success(repository.initiateOrder(giftCardId, patientId))
    } catch (e: HttpException) {
        Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
