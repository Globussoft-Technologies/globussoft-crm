package com.globus.crm.feature.wallet.data.repository

import com.globus.crm.core.network.WellnessApiService
import com.globus.crm.feature.wallet.data.mapper.toDomain
import com.globus.crm.feature.wallet.domain.model.WalletSummary
import com.globus.crm.feature.wallet.domain.repository.WalletRepository
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class WalletRepositoryImpl @Inject constructor(
    private val api: WellnessApiService,
) : WalletRepository {

    override suspend fun getWalletSummary(patientId: Int): WalletSummary {
        val response = api.getPatientWallet(patientId)
        if (!response.isSuccessful) throw HttpException(response)
        return response.body()!!.toDomain()
    }

    override suspend fun getMyTransactions(): WalletSummary {
        val response = api.getMyTransactions()
        if (!response.isSuccessful) throw HttpException(response)
        return response.body()!!.toDomain()
    }
}
