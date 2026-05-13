package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Service
import com.globussoft.wellness.core.network.model.response.ServiceResponse

/**
 * Maps a [ServiceResponse] network DTO to the [Service] domain model.
 *
 * All fields are direct projections — no derived values are computed here
 * because the service catalog is display-only on the mobile app (editing
 * is an admin/web function).
 */
fun ServiceResponse.toDomain(): Service = Service(
    id             = id,
    name           = name,
    category       = category,
    basePrice      = basePrice,
    durationMin    = durationMin,
    targetRadiusKm = targetRadiusKm,
    description    = description,
    ticketTier     = ticketTier,
    isActive       = isActive,
)
