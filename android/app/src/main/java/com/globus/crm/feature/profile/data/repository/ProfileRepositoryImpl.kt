package com.globus.crm.feature.profile.data.repository

import com.globus.crm.core.network.WellnessApiService
import com.globus.crm.core.storage.DataStoreManager
import com.globus.crm.core.storage.EncryptedPrefsManager
import com.globus.crm.feature.profile.data.mapper.mergeInto
import com.globus.crm.feature.profile.data.mapper.toDomain
import com.globus.crm.feature.profile.data.remote.dto.UpdateAuthProfileDto
import com.globus.crm.feature.profile.domain.model.Profile
import com.globus.crm.feature.profile.domain.repository.ProfileRepository
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ProfileRepositoryImpl @Inject constructor(
    private val api: WellnessApiService,
    private val dataStore: DataStoreManager,
    private val encryptedPrefs: EncryptedPrefsManager,
) : ProfileRepository {

    override suspend fun getProfile(): Profile {
        val response = api.getProfile()
        if (!response.isSuccessful) throw HttpException(response)
        var profile = response.body()!!.toDomain()
        // Merge profilePicture from the auth layer (best-effort — doesn't fail the load)
        try {
            val authResponse = api.getAuthProfile()
            if (authResponse.isSuccessful) {
                profile = authResponse.body()!!.mergeInto(profile)
            }
        } catch (_: Exception) { }
        return profile
    }

    override suspend fun updateProfile(
        name: String?,
        email: String?,
        currentPassword: String?,
        newPassword: String?,
    ): Profile {
        val current = getProfile()
        val response = api.updateAuthProfile(
            UpdateAuthProfileDto(
                name = name,
                email = email,
                currentPassword = currentPassword,
                newPassword = newPassword,
            )
        )
        if (!response.isSuccessful) throw HttpException(response)
        val updated = response.body()!!.mergeInto(current)
        encryptedPrefs.saveUserInfo(encryptedPrefs.getUserId(), updated.name, updated.email ?: "")
        return updated
    }

    override suspend fun uploadProfilePicture(bytes: ByteArray, mimeType: String): Profile {
        val requestBody = bytes.toRequestBody(mimeType.toMediaType())
        val part = MultipartBody.Part.createFormData("file", "profile.jpg", requestBody)
        val response = api.uploadProfilePicture(part)
        if (!response.isSuccessful) throw HttpException(response)
        val current = try { getProfile() } catch (_: Exception) {
            val dto = response.body()!!
            Profile(patientId = 0, name = dto.name, phone = null, email = dto.email, dob = null, gender = null)
        }
        return response.body()!!.mergeInto(current)
    }

    override suspend fun removeProfilePicture(): Profile {
        val response = api.deleteProfilePicture()
        if (!response.isSuccessful) throw HttpException(response)
        val current = try { getProfile() } catch (_: Exception) {
            val dto = response.body()!!
            Profile(patientId = 0, name = dto.name, phone = null, email = dto.email, dob = null, gender = null)
        }
        return current.copy(profilePictureUrl = null)
    }

    override suspend fun requestDsarExport() {
        val response = api.requestDsarExport()
        if (!response.isSuccessful) throw HttpException(response)
    }

    override suspend fun logout() {
        dataStore.clearAll()
        encryptedPrefs.clear()
    }
}
