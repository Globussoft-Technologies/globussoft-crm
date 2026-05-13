package com.globussoft.wellness.core.network.model.request

/**
 * Request body for POST /api/wellness/visits.
 *
 * [travelTimeMinutes] — required only for AT_HOME booking types; null otherwise.
 * [visitDate]         — ISO-8601 datetime string (e.g. "2026-05-13T10:30:00.000Z").
 * [bookingType]       — one of "CLINIC_VISIT" | "AT_HOME" | "VIDEO" | "PHONE".
 */
data class CreateVisitRequest(
    val patientId: String,
    val doctorId: String?,
    val serviceId: String?,
    val locationId: String?,
    val visitDate: String,
    val bookingType: String,
    val notes: String?,
    val travelTimeMinutes: Int?,
)
