package com.globus.crm.feature.loyalty.domain.model

data class LoyaltyData(
    val balance: Int,
    val earnedThisMonth: Int,
    val transactions: List<LoyaltyTransaction>,
)

data class LoyaltyTransaction(
    val id: Int,
    val type: String,
    val points: Int,
    val reason: String,
    val createdAt: String,
)
