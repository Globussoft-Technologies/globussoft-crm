package com.globussoft.wellness.core.network.model.response

data class PipelineResponse(
    val id: String,
    val name: String,
    val isDefault: Boolean?,
    val stages: List<PipelineStageResponse>?,
)

data class PipelineStageResponse(
    val id: String,
    val name: String,
    val order: Int,
    val _count: PipelineStageCountResponse?,
)

data class PipelineStageCountResponse(
    val deals: Int?,
)
