package com.globus.crm.feature.catalog.domain.model

data class Service(
    val id: Int,
    val name: String,
    val description: String?,
    val price: Double?,
    val discountedPrice: Double?,
    val imageUrl: String?,
    val categoryName: String?,
    val duration: Int?,    // minutes, may be null
    val isActive: Boolean,
)

data class ServiceCategory(
    val id: Int,
    val name: String,
    val parentId: Int?,
    val imageUrl: String?,
    val color: String?,
    val servicesCount: Int,
)
