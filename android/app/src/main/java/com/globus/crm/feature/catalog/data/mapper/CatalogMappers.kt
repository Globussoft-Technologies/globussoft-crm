package com.globus.crm.feature.catalog.data.mapper

import com.globus.crm.feature.catalog.data.remote.dto.CatalogServiceCategoryDto
import com.globus.crm.feature.catalog.data.remote.dto.CatalogServiceDto
import com.globus.crm.feature.catalog.domain.model.Service
import com.globus.crm.feature.catalog.domain.model.ServiceCategory

fun CatalogServiceDto.toDomain() = Service(
    id = id,
    name = name,
    description = description,
    price = basePrice,
    discountedPrice = discountedPrice,
    imageUrl = imageUrls,
    categoryName = category,
    duration = durationMin,
    isActive = isActive ?: true,
)

fun CatalogServiceCategoryDto.toDomain() = ServiceCategory(
    id = id,
    name = name,
    parentId = parentId,
    imageUrl = imageUrl,
    color = color,
    servicesCount = count?.services ?: 0,
)
