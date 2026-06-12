package com.globus.crm.feature.membership.domain.model

data class Membership(
    val id: Int,
    val planId: Int,
    val planName: String,
    val planDurationDays: Int,
    val startDate: String,
    val endDate: String,
    val status: String,
    val balance: List<MembershipBalance>,
)

data class MembershipBalance(
    val serviceId: Int?,
    val serviceName: String?,
    val remaining: Int?,
    val used: Int?,
    val total: Int?,
)

data class MembershipPlan(
    val id: Int,
    val name: String,
    val description: String?,
    val price: Double,
    val currency: String,
    val durationDays: Int,
    val entitlements: String?,
)
