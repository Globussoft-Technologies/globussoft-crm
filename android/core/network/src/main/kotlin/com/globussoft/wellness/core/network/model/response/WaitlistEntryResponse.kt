package com.globussoft.wellness.core.network.model.response

/**
 * Waitlist entry record as returned by GET /api/wellness/waitlist.
 *
 * [patient]  — minimal patient projection; included when the backend performs
 *              a relational include on the list query.
 * [service]  — minimal service projection; included on the same condition.
 * [offeredAt]— ISO-8601 timestamp when a slot was offered; null if still WAITING.
 */
data class WaitlistEntryResponse(
    val id: String,
    val patientId: String,
    val patient: PatientMinResponse?,
    val serviceId: String?,
    val service: ServiceMinResponse?,
    val preferredDateRange: String?,
    val estimatedWaitMin: Int?,
    val status: String,
    val createdAt: String,
    val offeredAt: String?,
    val notes: String?,
)
