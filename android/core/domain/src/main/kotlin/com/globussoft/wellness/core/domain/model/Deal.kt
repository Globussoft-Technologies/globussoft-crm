package com.globussoft.wellness.core.domain.model

data class Deal(
    val id: String,
    val title: String,
    val amount: Double,
    val stage: String,
    val status: String,
    val probability: Int,
    val expectedClose: String?,
    val pipelineName: String?,
    val contactName: String?,
    val ownerName: String?,
    val createdAt: String?,
)

data class DealStats(
    val totalDeals: Int,
    val totalValue: Double,
    val wonCount: Int,
    val wonValue: Double,
    val lostCount: Int,
    val lostValue: Double,
    val expectedValue: Double,
    val conversionRate: Double,
    val openCount: Int,
)
