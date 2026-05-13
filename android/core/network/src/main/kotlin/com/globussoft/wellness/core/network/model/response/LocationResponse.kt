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
    val addressLine: String,
    val city: String,
    val state: String,
    val pincode: String,
    val phone: String?,
    val email: String?,
    val isActive: Boolean,
)
