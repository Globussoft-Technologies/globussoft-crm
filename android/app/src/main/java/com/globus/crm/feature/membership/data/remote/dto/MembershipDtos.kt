package com.globus.crm.feature.membership.data.remote.dto

import com.squareup.moshi.JsonClass

// GET /api/wellness/appointments/my-memberships — CUSTOMER JWT (verifyToken).
// Real shape confirmed against staging 2026-06-04.
@JsonClass(generateAdapter = true)
data class MembershipDto(
    val id: Int,
    val planId: Int,
    val planName: String,
    val planDurationDays: Int,
    val startDate: String,
    val endDate: String,
    val createdAt: String,
    val status: String,
    val balance: List<MembershipBalanceDto> = emptyList(),
)

// balance[] items represent per-service credit balances (structure may be populated
// by backend in future; currently always empty []).
@JsonClass(generateAdapter = true)
data class MembershipBalanceDto(
    val serviceId: Int? = null,
    val serviceName: String? = null,
    val remaining: Int? = null,
    val used: Int? = null,
    val total: Int? = null,
)

// GET /api/wellness/membership-plans — CUSTOMER JWT (verifyToken).
// entitlements is a raw JSON string containing cashback rules, wallet credit schedules, etc.
@JsonClass(generateAdapter = true)
data class MembershipPlanDto(
    val id: Int,
    val tenantId: Int,
    val name: String,
    val description: String?,
    val price: Double,
    val currency: String,
    val durationDays: Int,
    val entitlements: String?,
)
