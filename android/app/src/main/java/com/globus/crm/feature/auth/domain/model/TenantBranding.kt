package com.globus.crm.feature.auth.domain.model

data class TenantBranding(
    val id: Int,
    val slug: String,
    val name: String,
    val brandColor: String?,
    val logoUrl: String?,
    val tagline: String?,
)
