package com.globussoft.wellness.core.domain.model

/**
 * A physical clinic / branch location belonging to the wellness tenant.
 *
 * Multi-location support means patients and visits can be scoped to a
 * specific [Location] via `locationId` foreign keys.
 *
 * [pincode]  — Indian 6-digit PIN code (or equivalent for non-IN tenants).
 * [isActive] — inactive locations are hidden from booking flows but retained
 *              for historical visit data.
 */
data class Location(
    val id: String,
    val name: String,
    val addressLine: String? = null,
    val city: String? = null,
    val state: String? = null,
    val pincode: String? = null,
    val phone: String? = null,
    val email: String? = null,
    val isActive: Boolean = true,
)
