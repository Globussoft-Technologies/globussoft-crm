package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Pipeline
import com.globussoft.wellness.core.domain.model.PipelineStage
import com.globussoft.wellness.core.network.model.response.PipelineResponse
import com.globussoft.wellness.core.network.model.response.PipelineStageResponse

fun PipelineResponse.toDomain(): Pipeline = Pipeline(
    id = id,
    name = name,
    isDefault = isDefault ?: false,
    stages = stages?.map { it.toDomain() } ?: emptyList(),
)

fun PipelineStageResponse.toDomain(): PipelineStage = PipelineStage(
    id = id,
    name = name,
    order = order,
    dealCount = _count?.deals ?: 0,
)
