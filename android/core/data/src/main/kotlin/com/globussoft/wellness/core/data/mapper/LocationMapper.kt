package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.core.network.model.response.LocationResponse

/**
 * Maps a [LocationResponse] network DTO to the [Location] domain model.
 *
 * All fields are direct projections; the domain model is intentionally
 * identical to the DTO for this simple value object.
 */
fun LocationResponse.toDomain(): Location = Location(
    id          = id,
    name        = name,
    addressLine = addressLine,
    city        = city,
    state       = state,
    pincode     = pincode,
    phone       = phone,
    email       = email,
    isActive    = isActive,
)
