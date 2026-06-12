package com.globus.crm.feature.catalog.data.repository

import com.globus.crm.core.network.WellnessApiService
import com.globus.crm.feature.catalog.data.mapper.toDomain
import com.globus.crm.feature.catalog.domain.model.Service
import com.globus.crm.feature.catalog.domain.model.ServiceCategory
import com.globus.crm.feature.catalog.domain.repository.CatalogRepository
import retrofit2.HttpException
import javax.inject.Inject

class CatalogRepositoryImpl @Inject constructor(
    private val api: WellnessApiService,
) : CatalogRepository {

    override suspend fun getServices(): List<Service> {
        val response = api.getCatalogServices()
        if (!response.isSuccessful) throw HttpException(response)
        return response.body().orEmpty().map { it.toDomain() }
    }

    override suspend fun getCategories(): List<ServiceCategory> {
        val response = api.getCatalogServiceCategories()
        if (!response.isSuccessful) throw HttpException(response)
        return response.body().orEmpty().map { it.toDomain() }
    }
}
