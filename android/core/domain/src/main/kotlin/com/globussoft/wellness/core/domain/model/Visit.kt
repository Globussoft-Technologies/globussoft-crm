package com.globussoft.wellness.core.domain.model

/**
 * A single patient visit / appointment in the wellness vertical.
 *
 * [travelTimeMinutes] — populated only for AT_HOME booking types.
 * [duration]          — planned duration in minutes from the linked service.
 * [amount]            — billed/quoted amount; may be null until check-out.
 */
data class Visit(
    val id: String,
    val patientId: String,
    val patientName: String?,
    val doctorId: String?,
    val doctorName: String?,
    val serviceId: String?,
    val serviceName: String?,
    val locationId: String?,
    val visitDate: String,
    val status: VisitStatus,
    val bookingType: BookingType,
    val travelTimeMinutes: Int?,
    val notes: String?,
    val amount: Double?,
    val duration: Int?,
)

/**
 * Lifecycle states of a visit — mirrors the backend `Visit.status` enum.
 */
enum class VisitStatus {
    BOOKED,
    CONFIRMED,
    ARRIVED,
    IN_TREATMENT,
    COMPLETED,
    NO_SHOW,
    CANCELLED,
}

/**
 * Delivery modality of a visit — mirrors the backend `Visit.bookingType` enum.
 */
enum class BookingType {
    CLINIC_VISIT,
    AT_HOME,
    VIDEO,
    PHONE,
}
