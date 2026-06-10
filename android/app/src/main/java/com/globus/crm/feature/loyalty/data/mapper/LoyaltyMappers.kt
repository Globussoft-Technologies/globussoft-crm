package com.globus.crm.feature.loyalty.data.mapper

import com.globus.crm.feature.loyalty.data.remote.dto.LoyaltyResponseDto
import com.globus.crm.feature.loyalty.data.remote.dto.LoyaltyTransactionDto
import com.globus.crm.feature.loyalty.domain.model.LoyaltyData
import com.globus.crm.feature.loyalty.domain.model.LoyaltyTransaction

fun LoyaltyResponseDto.toDomain() = LoyaltyData(
    balance = balance,
    earnedThisMonth = earnedThisMonth,
    transactions = transactions.map { it.toDomain() },
)

fun LoyaltyTransactionDto.toDomain() = LoyaltyTransaction(
    id = id,
    type = type,
    points = points,
    reason = reason,
    createdAt = createdAt,
)
