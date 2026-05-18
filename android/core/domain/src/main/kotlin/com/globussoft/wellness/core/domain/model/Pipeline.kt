package com.globussoft.wellness.core.domain.model

data class Pipeline(
    val id: String,
    val name: String,
    val isDefault: Boolean,
    val stages: List<PipelineStage>,
)

data class PipelineStage(
    val id: String,
    val name: String,
    val order: Int,
    val dealCount: Int,
)
