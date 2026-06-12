package com.globus.crm.feature.profile.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.profile.domain.model.Profile
import com.globus.crm.feature.profile.domain.repository.ProfileRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class UpdateProfileUseCase @Inject constructor(
    private val repository: ProfileRepository,
) {
    suspend operator fun invoke(
        name: String? = null,
        email: String? = null,
        currentPassword: String? = null,
        newPassword: String? = null,
    ): Result<Profile> = try {
        Result.Success(repository.updateProfile(name, email, currentPassword, newPassword))
    } catch (e: HttpException) {
        when (e.code()) {
            400 -> Result.Error("INVALID_INPUT", "Invalid input — check your current password", 400)
            401 -> Result.Error("UNAUTHORIZED", "Current password is incorrect", 401)
            else -> Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
        }
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
