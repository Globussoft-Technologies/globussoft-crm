package com.globussoft.wellness.core.network.model.response

/**
 * Clinic branch / location record as returned by GET /api/wellness/locations.
 *
 * [pincode]  — Indian 6-digit PIN code or equivalent for non-IN tenants.
 * [isActive] — inactive locations are excluded from booking flows.
 */
data class LocationResponse(
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
