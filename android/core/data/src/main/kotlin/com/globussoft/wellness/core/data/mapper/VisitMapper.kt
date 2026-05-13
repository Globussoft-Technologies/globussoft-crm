package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.BookingType
import com.globussoft.wellness.core.domain.model.Visit
import com.globussoft.wellness.core.domain.model.VisitStatus
import com.globussoft.wellness.core.network.model.response.VisitResponse

/**
 * Maps a [VisitResponse] network DTO to the [Visit] domain model.
 *
 * [status] and [bookingType] are stored as strings in the API response and
 * converted to their corresponding sealed enums. Unknown values fall back to
 * [VisitStatus.BOOKED] and [BookingType.CLINIC_VISIT] respectively so the
 * app degrades gracefully if the backend introduces new enum values in a
 * future API version before the app is updated.
 *
 * Nested [patient], [doctor], and [service] projections are flattened into
 * top-level nullable name fields on the domain model to simplify display logic.
 */
fun VisitResponse.toDomain(): Visit = Visit(
    id                 = id,
    patientId          = patientId,
    patientName        = patient?.name,
    doctorId           = doctorId,
    doctorName         = doctor?.name,
    serviceId          = serviceId,
    serviceName        = service?.name,
    locationId         = locationId,
    visitDate          = visitDate,
    status             = status.toVisitStatus(),
    bookingType        = bookingType.toBookingType(),
    travelTimeMinutes  = travelTimeMinutes,
    notes              = notes,
    amount             = amount,
    duration           = duration,
)

// ---------------------------------------------------------------------------
// String → enum helpers
// ---------------------------------------------------------------------------

private fun String.toVisitStatus(): VisitStatus = runCatching {
    VisitStatus.valueOf(this)
}.getOrDefault(VisitStatus.BOOKED)

private fun String.toBookingType(): BookingType = runCatching {
    BookingType.valueOf(this)
}.getOrDefault(BookingType.CLINIC_VISIT)
