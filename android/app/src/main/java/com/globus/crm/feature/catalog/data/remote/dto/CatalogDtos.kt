package com.globus.crm.feature.catalog.data.remote.dto

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

@JsonClass(generateAdapter = true)
data class CatalogServiceDto(
    val id: Int,
    val name: String,
    val description: String?,
    val basePrice: Double?,
    val discountedPrice: Double?,
    val imageUrls: String?,
    val category: String?,
    val categoryId: Int?,
    val durationMin: Int?,
    val isActive: Boolean?,
)

@JsonClass(generateAdapter = true)
data class CatalogServiceCategoryDto(
    val id: Int,
    val name: String,
    val parentId: Int?,
    val imageUrl: String?,
    val color: String?,
    @Json(name = "_count") val count: CategoryCountDto?,
)

@JsonClass(generateAdapter = true)
data class CategoryCountDto(
    val services: Int?,
)
