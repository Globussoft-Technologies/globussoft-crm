package com.globus.crm.feature.catalog.domain.repository

import com.globus.crm.feature.catalog.domain.model.Service
import com.globus.crm.feature.catalog.domain.model.ServiceCategory

interface CatalogRepository {
    suspend fun getServices(): List<Service>
    suspend fun getCategories(): List<ServiceCategory>
}
