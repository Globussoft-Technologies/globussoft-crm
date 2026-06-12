package com.globus.crm.feature.loyalty.data.remote.dto

import com.squareup.moshi.JsonClass

// GET /api/wellness/loyalty/{patientId} — CUSTOMER JWT (verifyToken).
// Real shape confirmed against staging 2026-06-04.
// ⚠️ SECURITY NOTE: This route accepts any patientId — the backend does NOT verify
// that the calling user owns that patient record. Flag to backend team to add
// ownership check (req.user.userId → Patient.userId === patientId).
@JsonClass(generateAdapter = true)
data class LoyaltyResponseDto(
    val patient: LoyaltyPatientRefDto? = null,
    val balance: Int,
    val earnedThisMonth: Int,
    val transactions: List<LoyaltyTransactionDto>,
)

@JsonClass(generateAdapter = true)
data class LoyaltyPatientRefDto(
    val id: Int,
    val name: String,
)

@JsonClass(generateAdapter = true)
data class LoyaltyTransactionDto(
    val id: Int,
    val patientId: Int,
    val type: String,
    val points: Int,
    val reason: String,
    val visitId: Int?,
    val tenantId: Int,
    val createdAt: String,
)
