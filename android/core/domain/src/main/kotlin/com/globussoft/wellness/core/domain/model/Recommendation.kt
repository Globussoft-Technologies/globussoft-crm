package com.globussoft.wellness.core.domain.model

/**
 * An AI-generated owner-dashboard recommendation card produced by the
 * wellness orchestrator engine (daily 07:00 IST).
 *
 * [priority]        — "high" / "medium" / "low".
 * [type]            — recommendation category (e.g. "revenue", "retention",
 *                     "ops", "clinical").
 * [status]          — "active" / "resolved" / "dismissed".
 * [expectedImpact]  — free-text impact estimate from the AI; may be null.
 * [resolvedAt]      — ISO-8601 timestamp; null when status != "resolved".
 */
data class Recommendation(
    val id: String,
    val title: String,
    val body: String,
    val priority: String,
    val type: String,
    val status: String,
    val expectedImpact: String?,
    val createdAt: String,
    val resolvedAt: String?,
)
