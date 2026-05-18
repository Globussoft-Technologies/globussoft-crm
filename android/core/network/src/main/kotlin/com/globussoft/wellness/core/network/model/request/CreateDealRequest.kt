package com.globussoft.wellness.core.network.model.request

data class CreateDealRequest(
    val title: String,
    val amount: Double?,
    val stage: String?,
    val pipelineId: String?,
    val probability: Int?,
    val expectedClose: String?,
    val contactId: String?,
)
