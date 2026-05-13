package com.globussoft.wellness.core.domain.model

/**
 * A staff member belonging to the tenant.
 *
 * [wellnessRole] — null for generic-tenant staff or staff that have no
 *                  clinic sub-role assigned.
 * [locationId]   — primary clinic location; null means the staff member
 *                  is not tied to a specific location.
 */
data class Staff(
    val id: String,
    val name: String,
    val email: String,
    val wellnessRole: WellnessRole?,
    val role: UserRole,
    val locationId: String?,
)
