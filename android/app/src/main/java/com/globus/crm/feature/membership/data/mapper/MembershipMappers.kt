package com.globus.crm.feature.membership.data.mapper

import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.membership.data.local.entity.CachedMembership
import com.globus.crm.feature.membership.data.remote.dto.MembershipBalanceDto
import com.globus.crm.feature.membership.data.remote.dto.MembershipDto
import com.globus.crm.feature.membership.data.remote.dto.MembershipPlanDto
import com.globus.crm.feature.membership.domain.model.Membership
import com.globus.crm.feature.membership.domain.model.MembershipBalance
import com.globus.crm.feature.membership.domain.model.MembershipPlan

fun MembershipDto.toDomain() = Membership(
    id = id,
    planId = planId,
    planName = planName,
    planDurationDays = planDurationDays,
    startDate = startDate,
    endDate = endDate,
    status = status,
    balance = balance.map { it.toDomain() },
)

fun MembershipBalanceDto.toDomain() = MembershipBalance(
    serviceId = serviceId,
    serviceName = serviceName,
    remaining = remaining,
    used = used,
    total = total,
)

fun MembershipPlanDto.toDomain() = MembershipPlan(
    id = id,
    name = name,
    description = description.sanitiseDescription(),
    price = price,
    currency = currency,
    durationDays = durationDays,
    entitlements = entitlements,
)

private fun String?.sanitiseDescription(): String? {
    if (this == null) return null
    val cleaned = lines()
        .filterNot { line ->
            line.contains("zylu", ignoreCase = true) ||
                line.trimStart().startsWith("Imported from", ignoreCase = true)
        }
        .joinToString("\n")
        .trim()
    return cleaned.ifBlank { null }
}

fun Membership.toEntity(): CachedMembership {
    val startMs = DateUtil.isoToEpochMs(startDate)
    val endMs = DateUtil.isoToEpochMs(endDate)
    val daysLeft = ((endMs - System.currentTimeMillis()) / (1000 * 60 * 60 * 24)).toInt().coerceAtLeast(0)
    return CachedMembership(
        id = id,
        status = status,
        startDate = startMs,
        endDate = endMs,
        daysLeft = daysLeft,
        planName = planName,
        planPrice = 0.0,
        planCurrency = "INR",
        creditsJson = "[]",
        historyJson = "[]",
        cachedAt = System.currentTimeMillis(),
    )
}

fun CachedMembership.toDomain() = Membership(
    id = id,
    planId = 0,
    planName = planName,
    planDurationDays = 0,
    startDate = DateUtil.epochMsToIso(startDate),
    endDate = DateUtil.epochMsToIso(endDate),
    status = status,
    balance = emptyList(),
)
