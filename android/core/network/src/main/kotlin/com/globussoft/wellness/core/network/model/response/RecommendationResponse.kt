package com.globussoft.wellness.core.network.model.response

/**
 * AI-generated owner-dashboard recommendation card as returned by
 * GET /api/wellness/recommendations.
 *
 * [priority]       — "high" | "medium" | "low".
 * [type]           — recommendation category (e.g. "revenue", "retention", "ops", "clinical").
 * [status]         — "active" | "resolved" | "dismissed".
 * [expectedImpact] — free-text AI impact estimate; may be null.
 * [resolvedAt]     — ISO-8601 timestamp; null when [status] is not "resolved".
 */
data class RecommendationResponse(
    val id: String,
    val title: String,
    val body: String,
    val priority: String,
    val type: String,
    val status: String,
    val expectedImpact: String?,
    val createdAt: String?,
    val resolvedAt: String?,
)
