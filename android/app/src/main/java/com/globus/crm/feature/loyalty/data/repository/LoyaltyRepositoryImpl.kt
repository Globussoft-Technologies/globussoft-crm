package com.globus.crm.feature.loyalty.data.repository

import com.globus.crm.core.network.WellnessApiService
import com.globus.crm.core.storage.EncryptedPrefsManager
import com.globus.crm.feature.loyalty.data.mapper.toDomain
import com.globus.crm.feature.loyalty.domain.model.LoyaltyData
import com.globus.crm.feature.loyalty.domain.repository.LoyaltyRepository
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class LoyaltyRepositoryImpl @Inject constructor(
    private val api: WellnessApiService,
    private val encryptedPrefs: EncryptedPrefsManager,
) : LoyaltyRepository {

    override suspend fun getLoyalty(): LoyaltyData {
        val patientId = encryptedPrefs.getPatientId()
            ?: throw IllegalStateException("patientId not cached")
        val response = api.getLoyalty(patientId)
        if (!response.isSuccessful) throw HttpException(response)
        return response.body()!!.toDomain()
    }
}
