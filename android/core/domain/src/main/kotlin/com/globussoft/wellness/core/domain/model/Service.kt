package com.globussoft.wellness.core.domain.model

/**
 * A treatment / service offered by the wellness clinic.
 *
 * [targetRadiusKm] — applicable only for AT_HOME services; null otherwise.
 * [ticketTier]     — optional pricing tier tag (e.g. "premium", "standard").
 * [durationMin]    — default appointment block length in minutes.
 */
data class Service(
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
