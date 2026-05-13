package com.globussoft.wellness.core.network.model.response

/**
 * Visit / appointment record as returned by the Wellness CRM API.
 *
 * [patient], [doctor], [service] are included when the backend SELECT performs
 * a relational include; they will be null on lighter list queries that omit
 * the include clause.
 */
data class VisitResponse(
    val id: String,
    val patientId: String,
    val patient: PatientMinResponse?,
    val doctorId: String?,
    val doctor: UserMinResponse?,
    val serviceId: String?,
    val service: ServiceMinResponse?,
    val locationId: String?,
    val visitDate: String,
    val status: String,
    val bookingType: String,
    val travelTimeMinutes: Int?,
    val notes: String?,
    val amount: Double?,
    val duration: Int?,
    val createdAt: String,
)

/**
 * Minimal patient projection embedded inside [VisitResponse].
 */
data class PatientMinResponse(
    val id: String,
    val name: String,
    val phone: String,
)

/**
 * Minimal user (doctor / staff) projection embedded inside [VisitResponse].
 */
data class UserMinResponse(
    val id: String,
    val name: String,
)

/**
 * Minimal service projection embedded inside [VisitResponse] and
 * [WaitlistEntryResponse].
 */
data class ServiceMinResponse(
    val id: String,
    val name: String,
)
