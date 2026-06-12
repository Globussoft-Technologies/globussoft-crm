package com.globus.crm.feature.auth.data.remote.dto

import com.squareup.moshi.JsonClass

@JsonClass(generateAdapter = true)
data class LoginRequestDto(
    val email: String,
    val password: String,
//    val loginTenantId: Int?,
)

@JsonClass(generateAdapter = true)
data class UserSummaryDto(
    val id: Int,
    val email: String,
    val name: String,
    val userType: String,
)

@JsonClass(generateAdapter = true)
data class TenantSummaryDto(
    val id: Int,
    val name: String,
    val slug: String,
    val brandColor: String?,
    val logoUrl: String?,
)

@JsonClass(generateAdapter = true)
data class LoginResponseDto(
    val token: String,
    val user: UserSummaryDto,
    val tenant: TenantSummaryDto?,
)

@JsonClass(generateAdapter = true)
data class RegisterRequestDto(
    val email: String,
    val password: String,
    val name: String,
    val registrationTenantId: Int,
)

@JsonClass(generateAdapter = true)
data class RegisterResponseDto(
    val token: String,
    val user: UserSummaryDto,
    val tenant: TenantSummaryDto?,
)

@JsonClass(generateAdapter = true)
data class TenantBrandingDto(
    val id: Int,
    val slug: String,
    val name: String,
    val brandColor: String? = null,
    val logoUrl: String? = null,
    val tagline: String? = null,
)

// Wrapper for GET /public/tenant/{slug} — response shape: { "tenant": {...}, "services": [...] }
@JsonClass(generateAdapter = true)
data class TenantBrandingResponseDto(
    val tenant: TenantBrandingDto,
)

// GET /portal/me/permissions — { "permissions": ["my_prescriptions.read", "products.read"] }
@JsonClass(generateAdapter = true)
data class PatientPermissionsDto(
    val permissions: List<String>,
)

// GET /portal/health — { "smsConfigured": true }
@JsonClass(generateAdapter = true)
data class PortalHealthDto(
    val smsConfigured: Boolean,
)
