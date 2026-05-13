package com.globussoft.wellness.core.network.model.response

/**
 * Staff member record as returned by GET /api/wellness/staff.
 *
 * [wellnessRole] — null for staff without a clinic sub-role.
 * [locationId]   — primary clinic branch for this staff member; null if unassigned.
 */
data class StaffResponse(
    val id: String,
    val name: String,
    val email: String,
    val role: String,
    val wellnessRole: String?,
    val locationId: String?,
)
