package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.WaitlistEntry
import com.globussoft.wellness.core.domain.model.WaitlistStatus
import com.globussoft.wellness.core.network.model.response.WaitlistEntryResponse

/**
 * Maps a [WaitlistEntryResponse] network DTO to the [WaitlistEntry] domain model.
 *
 * [status] is a string in the API response and converted to [WaitlistStatus].
 * Unknown values fall back to [WaitlistStatus.WAITING] so the app degrades
 * gracefully if the backend introduces new lifecycle states.
 *
 * Nested [patient] and [service] projections are flattened into top-level
 * nullable name/phone fields on the domain model.
 */
fun WaitlistEntryResponse.toDomain(): WaitlistEntry = WaitlistEntry(
    id                  = id,
    patientId           = patientId,
    patientName         = patient?.name,
    patientPhone        = patient?.phone,
    serviceId           = serviceId,
    serviceName         = service?.name,
    preferredDateRange  = preferredDateRange,
    estimatedWaitMin    = estimatedWaitMin,
    status              = status.toWaitlistStatus(),
    createdAt           = createdAt,
    offeredAt           = offeredAt,
    notes               = notes,
)

// ---------------------------------------------------------------------------
// String → enum helper
// ---------------------------------------------------------------------------

private fun String.toWaitlistStatus(): WaitlistStatus = runCatching {
    WaitlistStatus.valueOf(this)
}.getOrDefault(WaitlistStatus.WAITING)
