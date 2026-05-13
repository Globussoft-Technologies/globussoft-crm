package com.globussoft.wellness.core.network.model.response

/**
 * Treatment / service catalog entry as returned by GET /api/wellness/services.
 *
 * [targetRadiusKm] — delivery radius for AT_HOME services; null for clinic-only services.
 * [ticketTier]     — optional pricing tier tag (e.g. "premium", "standard", "basic").
 * [isActive]       — inactive services are hidden from public booking but retained
 *                    for historical visit records.
 */
data class ServiceResponse(
    val id: String,
    val name: String,
    val category: String?,
    val basePrice: Double,
    val durationMin: Int,
    val targetRadiusKm: Double?,
    val description: String?,
    val ticketTier: String?,
    val isActive: Boolean,
)
