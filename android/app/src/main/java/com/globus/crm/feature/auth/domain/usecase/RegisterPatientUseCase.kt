package com.globus.crm.feature.auth.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.model.Patient
import com.globus.crm.feature.auth.domain.repository.AuthRepository
import org.json.JSONObject
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class RegisterPatientUseCase @Inject constructor(
    private val repository: AuthRepository,
) {
    suspend operator fun invoke(email: String, password: String, name: String): Result<Patient> = try {
        Result.Success(repository.register(email, password, name))
    } catch (e: HttpException) {
        val rawBody = runCatching { e.response()?.errorBody()?.string() }.getOrNull() ?: ""
        val backendMessage = runCatching {
            JSONObject(rawBody).getString("error")
        }.getOrNull()
        when (e.code()) {
            400 -> Result.Error("INVALID_INPUT", backendMessage ?: "Please check your details and try again", 400)
            409 -> Result.Error("ALREADY_REGISTERED", backendMessage ?: "This email is already registered", 409)
            422 -> Result.Error("VALIDATION_ERROR", backendMessage ?: "Invalid input. Please check your details.", 422)
            else -> Result.Error("HTTP_${e.code()}", backendMessage ?: e.message() ?: "Server error", e.code())
        }
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
