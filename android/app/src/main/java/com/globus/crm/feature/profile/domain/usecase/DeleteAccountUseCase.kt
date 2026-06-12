package com.globus.crm.feature.profile.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.profile.domain.repository.ProfileRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class DeleteAccountUseCase @Inject constructor(
    private val repository: ProfileRepository,
) {
    suspend operator fun invoke(): Result<Unit> = try {
        repository.deleteAccount()
        Result.Success(Unit)
    } catch (e: HttpException) {
        if (e.code() == 401) Result.Error("UNAUTHORIZED", "Session expired", 401)
        else Result.Error("HTTP_${e.code()}", e.message() ?: "Request failed", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection")
    }
}
