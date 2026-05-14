package com.globussoft.wellness.core.domain.model

/**
 * A course-of-treatment plan linking a patient, a service, and a session quota.
 *
 * [completedSessions] is derived server-side from linked visit records.
 * [status] reflects ACTIVE / PAUSED / CANCELLED / COMPLETED lifecycle.
 */
data class TreatmentPlan(
    val id: String,
    val name: String,
    val patientId: String,
    val serviceName: String?,
    val totalSessions: Int,
    val completedSessions: Int,
    val totalPrice: Double?,
    val status: String,
    val startedAt: String?,
    val nextDueAt: String?,
)
