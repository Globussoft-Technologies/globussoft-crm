package com.globus.crm.feature.profile.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.profile.domain.model.Profile
import com.globus.crm.feature.profile.domain.repository.ProfileRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class UploadProfilePictureUseCase @Inject constructor(
    private val repository: ProfileRepository,
) {
    suspend operator fun invoke(bytes: ByteArray, mimeType: String): Result<Profile> = try {
        Result.Success(repository.uploadProfilePicture(bytes, mimeType))
    } catch (e: HttpException) {
        when (e.code()) {
            400 -> Result.Error("NO_FILE", "No file uploaded", 400)
            415 -> Result.Error("UNSUPPORTED_MEDIA", "Only image files are supported", 415)
            503 -> Result.Error("STORAGE_UNCONFIGURED", "Photo upload is not available right now", 503)
            else -> Result.Error("HTTP_${e.code()}", e.message() ?: "Upload failed", e.code())
        }
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
