package com.globus.crm.feature.auth.data.repository

import com.globus.crm.BuildConfig
import com.globus.crm.core.network.WellnessApiService
import com.globus.crm.core.storage.DataStoreManager
import com.globus.crm.core.storage.EncryptedPrefsManager
import com.globus.crm.feature.auth.data.mapper.toDomain
import com.globus.crm.feature.auth.data.mapper.toPatient
import com.globus.crm.feature.auth.data.remote.dto.LoginRequestDto
import com.globus.crm.feature.auth.data.remote.dto.RegisterRequestDto
import com.globus.crm.feature.auth.domain.model.Patient
import com.globus.crm.feature.auth.domain.model.PatientPermissions
import com.globus.crm.feature.auth.domain.model.TenantBranding
import com.globus.crm.feature.auth.domain.repository.AuthRepository
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AuthRepositoryImpl @Inject constructor(
    private val api: WellnessApiService,
    private val dataStore: DataStoreManager,
    private val encryptedPrefs: EncryptedPrefsManager,
) : AuthRepository {

    override suspend fun getTenantBranding(slug: String): TenantBranding {
        val response = api.getTenantBranding(slug)
        if (!response.isSuccessful) throw HttpException(response)
        return response.body()!!.tenant.toDomain()
    }

    override suspend fun login(email: String, password: String): Patient {
        val response = api.login(LoginRequestDto(email = email, password = password,
//            loginTenantId = BuildConfig.TENANT_ID as Int?
        ))
        if (!response.isSuccessful) throw HttpException(response)
        val body = response.body()!!
        dataStore.saveToken(body.token)
        val patient = body.toPatient()
        encryptedPrefs.saveUserInfo(patient.userId, patient.name, patient.email)
        fetchAndSavePatientId()
        return patient
    }

    override suspend fun register(email: String, password: String, name: String): Patient {
        val response = api.registerCustomer(
            RegisterRequestDto(
                email = email,
                password = password,
                name = name,
                registrationTenantId = BuildConfig.TENANT_ID,
            )
        )
        if (!response.isSuccessful) throw HttpException(response)
        val body = response.body()!!
        dataStore.saveToken(body.token)
        val patient = body.toPatient()
        encryptedPrefs.saveUserInfo(patient.userId, patient.name, patient.email)
        fetchAndSavePatientId()
        return patient
    }

    // GET /portal/me after login to cache the patient-row ID.
    // Required for loyalty/{patientId}, patients/{patientId}/wallet, etc.
    // Non-fatal: if it fails the patientId will be fetched lazily when first needed.
    private suspend fun fetchAndSavePatientId() {
        runCatching { api.getProfile() }
            .getOrNull()
            ?.body()
            ?.id
            ?.let { encryptedPrefs.savePatientId(it) }
    }

    override suspend fun logout() {
        dataStore.clearAll()
        encryptedPrefs.clear()
    }

    override suspend fun hasValidToken(): Boolean = dataStore.getToken() != null

    override suspend fun getPatientPermissions(): PatientPermissions {
        val response = api.getPatientPermissions()
        if (!response.isSuccessful) throw HttpException(response)
        return PatientPermissions(response.body()!!.permissions.toSet())
    }

    override suspend fun isSmsAvailable(): Boolean {
        return runCatching { api.getPortalHealth() }
            .getOrNull()
            ?.body()
            ?.smsConfigured
            ?: true
    }
}
