package com.globus.crm.feature.health.data.repository

import com.globus.crm.core.network.WellnessApiService
import com.globus.crm.core.storage.EncryptedPrefsManager
import com.globus.crm.feature.health.data.mapper.toDomain
import com.globus.crm.feature.health.domain.model.TreatmentPlan
import com.globus.crm.feature.health.domain.repository.TreatmentPlanRepository
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TreatmentPlanRepositoryImpl @Inject constructor(
    private val api: WellnessApiService,
    private val encryptedPrefs: EncryptedPrefsManager,
) : TreatmentPlanRepository {

    override suspend fun getTreatmentPlans(): List<TreatmentPlan> {
        val patientId = encryptedPrefs.getPatientId()
            ?: throw IllegalStateException("patientId not cached")
        val response = api.getTreatmentPlans(patientId)
        if (!response.isSuccessful) throw HttpException(response)
        return response.body()!!.map { it.toDomain() }
    }
}
