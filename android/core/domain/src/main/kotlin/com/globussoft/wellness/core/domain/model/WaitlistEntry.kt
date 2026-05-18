package com.globussoft.wellness.core.domain.model

/**
 * A patient on the appointment waitlist for a service.
 *
 * [estimatedWaitMin]  — AI-estimated wait in minutes; null if not yet computed.
 * [preferredDateRange]— free-text or ISO range string indicating patient preference.
 * [offeredAt]         — ISO-8601 timestamp when a slot was offered; null if
 *                       status is still WAITING.
 */
data class WaitlistEntry(
    val id: String,
    val patientId: String,
    val patientName: String?,
    val patientPhone: String?,
    val serviceId: String?,
    val serviceName: String?,
    val preferredDateRange: String?,
    val estimatedWaitMin: Int?,
    val status: WaitlistStatus,
    val createdAt: String?,
    val offeredAt: String?,
    val notes: String?,
)

/**
 * Lifecycle states for a waitlist entry.
 *
 * WAITING  — patient is queued, no slot offered yet.
 * OFFERED  — a slot has been presented to the patient.
 * BOOKED   — patient accepted the slot; a [Visit] record now exists.
 * EXPIRED  — offered slot passed without patient confirmation.
 * CANCELLED— patient withdrew from the waitlist.
 */
enum class WaitlistStatus {
    WAITING,
    OFFERED,
    BOOKED,
    EXPIRED,
    CANCELLED,
}
