package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Lead
import com.globussoft.wellness.core.network.model.response.LeadResponse

/**
 * Maps a [LeadResponse] network DTO to the [Lead] domain model.
 *
 * The backend Contact model stores the display name in either [contactName]
 * (for CRM-created contacts) or [name] (for inbound / webhook-created contacts).
 * The mapper resolves the canonical name by preferring [contactName] when
 * non-null, falling back to [name], then defaulting to an empty string so
 * the UI always has a displayable value.
 */
fun LeadResponse.toDomain(): Lead = Lead(
    id            = id,
    contactName   = contactName ?: name ?: "",
    phone         = phone,
    leadScore     = leadScore,
    source        = source,
    createdAt     = createdAt,
    nextFollowUp  = nextFollowUp,
    status        = status,
)
