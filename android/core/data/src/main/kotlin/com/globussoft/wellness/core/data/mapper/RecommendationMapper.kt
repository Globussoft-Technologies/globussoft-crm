package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Recommendation
import com.globussoft.wellness.core.network.model.response.RecommendationResponse

/**
 * Maps a [RecommendationResponse] network DTO to the [Recommendation] domain model.
 *
 * All fields are direct projections. The domain model intentionally exposes
 * [priority], [type], and [status] as plain strings rather than enums because
 * the orchestrator may introduce new categories without a corresponding app
 * release; the UI handles unknown values gracefully via fallback display logic.
 */
fun RecommendationResponse.toDomain(): Recommendation = Recommendation(
    id             = id,
    title          = title,
    body           = body,
    priority       = priority,
    type           = type,
    status         = status,
    expectedImpact = expectedImpact,
    createdAt      = createdAt,
    resolvedAt     = resolvedAt,
)
