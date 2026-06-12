package com.globus.crm.feature.profile.data.remote.dto

import com.squareup.moshi.JsonClass

@JsonClass(generateAdapter = true)
data class ProfileDto(
    val id: Int,
    val name: String,
    val phone: String?,
    val email: String?,
    val dob: String?,
    val gender: String?,
)

@JsonClass(generateAdapter = true)
data class UpdateProfileDto(
    val name: String?,
    val email: String?,
    val dob: String?,
    val gender: String?,
)

@JsonClass(generateAdapter = true)
data class DsarExportResponseDto(
    val ok: Boolean,
    val message: String?,
)

// PUT /api/auth/me — CUSTOMER JWT (verifyToken). Updates name, email, or password.
// dob/gender/phone are patient-layer fields on GET /portal/me and cannot be updated via this endpoint.
@JsonClass(generateAdapter = true)
data class UpdateAuthProfileDto(
    val name: String? = null,
    val email: String? = null,
    val currentPassword: String? = null,
    val newPassword: String? = null,
)

@JsonClass(generateAdapter = true)
data class AuthProfileResponseDto(
    val id: Int,
    val name: String,
    val email: String?,
    val role: String,
    val profilePicture: String?,
    val createdAt: String? = null,
)

@JsonClass(generateAdapter = true)
data class DeleteAccountRequestDto(
    val confirmDestructive: Boolean = true,
    val password: String? = null,
    val code: String? = null,
)

@JsonClass(generateAdapter = true)
data class DeleteAccountResponseDto(
    val ok: Boolean,
    val deleted: String?,
)
