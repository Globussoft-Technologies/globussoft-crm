package com.globus.crm.feature.catalog.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.catalog.domain.model.ServiceCategory
import com.globus.crm.feature.catalog.domain.repository.CatalogRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetCategoriesUseCase @Inject constructor(
    private val repository: CatalogRepository,
) {
    suspend operator fun invoke(): Result<List<ServiceCategory>> = try {
        Result.Success(repository.getCategories())
    } catch (e: HttpException) {
        Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
