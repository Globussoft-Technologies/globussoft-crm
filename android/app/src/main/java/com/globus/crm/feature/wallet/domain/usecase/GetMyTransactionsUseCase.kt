package com.globus.crm.feature.wallet.domain.usecase

import com.globus.crm.core.storage.EncryptedPrefsManager
import com.globus.crm.core.util.Result
import com.globus.crm.feature.wallet.domain.model.WalletSummary
import com.globus.crm.feature.wallet.domain.repository.WalletRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetMyTransactionsUseCase @Inject constructor(
    private val repository: WalletRepository,
    private val encryptedPrefs: EncryptedPrefsManager,
) {
    suspend operator fun invoke(): Result<WalletSummary> = try {
        val patientId = encryptedPrefs.getPatientId()
        val summary = if (patientId != null) {
            try {
                repository.getWalletSummary(patientId)
            } catch (e: HttpException) {
                // 403 = CUSTOMER role not permitted on patient wallet endpoint → fall back to my-transactions
                if (e.code() == 403 || e.code() == 401) {
                    repository.getMyTransactions()
                } else throw e
            }
        } else {
            repository.getMyTransactions()
        }
        Result.Success(summary)
    } catch (e: HttpException) {
        Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
