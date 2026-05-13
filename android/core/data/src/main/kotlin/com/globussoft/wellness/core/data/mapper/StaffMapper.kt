package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Staff
import com.globussoft.wellness.core.domain.model.UserRole
import com.globussoft.wellness.core.domain.model.WellnessRole
import com.globussoft.wellness.core.network.model.response.StaffResponse

/**
 * Maps a [StaffResponse] network DTO to the [Staff] domain model.
 *
 * [role] and [wellnessRole] are stored as strings in the API response.
 * Unknown role strings fall back to [UserRole.USER] to avoid crashing on
 * future backend enum additions. [wellnessRole] remains null for staff
 * without a clinic sub-role (generic-tenant staff, admin helpers, etc.).
 */
fun StaffResponse.toDomain(): Staff = Staff(
    id          = id,
    name        = name,
    email       = email,
    wellnessRole = wellnessRole?.let {
        runCatching { WellnessRole.valueOf(it) }.getOrNull()
    },
    role        = runCatching { UserRole.valueOf(role) }.getOrDefault(UserRole.USER),
    locationId  = locationId,
)
