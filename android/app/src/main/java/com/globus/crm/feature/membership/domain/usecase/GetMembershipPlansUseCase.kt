package com.globus.crm.feature.membership.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.membership.domain.model.MembershipPlan
import com.globus.crm.feature.membership.domain.repository.MembershipRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetMembershipPlansUseCase @Inject constructor(
    private val repository: MembershipRepository,
) {
    suspend operator fun invoke(): Result<List<MembershipPlan>> = try {
        Result.Success(repository.getMembershipPlans())
    } catch (e: HttpException) {
        Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
