package com.globussoft.wellness.core.network.model.response

data class DealResponse(
    val id: String,
    val title: String?,
    val amount: Double?,
    val stage: String?,
    val status: String?,
    val probability: Int?,
    val expectedClose: String?,
    val pipelineId: String?,
    val pipeline: DealPipelineResponse?,
    val contact: DealContactResponse?,
    val owner: DealOwnerResponse?,
    val createdAt: String?,
    val updatedAt: String?,
)

data class DealStatsResponse(
    val totalDeals: Int,
    val totalValue: Double,
    val wonCount: Int,
    val wonValue: Double,
    val lostCount: Int,
    val lostValue: Double,
    val expectedValue: Double,
    val conversionRate: Double,
    val openCount: Int?,
)

data class DealPipelineResponse(
    val id: String,
    val name: String?,
)

data class DealContactResponse(
    val id: String,
    val contactName: String?,
    val name: String?,
    val company: String?,
)

data class DealOwnerResponse(
    val id: String,
    val name: String?,
)
