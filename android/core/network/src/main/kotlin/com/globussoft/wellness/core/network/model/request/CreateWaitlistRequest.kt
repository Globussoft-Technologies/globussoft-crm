package com.globussoft.wellness.core.network.model.request

/**
 * Request body for POST /api/wellness/waitlist.
 *
 * [preferredDateRange]  — free-text or ISO date-range string expressing patient
 *                         availability (e.g. "2026-06-01 to 2026-06-15").
 * [estimatedWaitMin]    — initial wait estimate in minutes; may be updated later
 *                         by the AI engine.
 * [notes]               — optional clinical or admin notes about the waitlist entry.
 */
data class CreateWaitlistRequest(
    val patientId: String,
    val serviceId: String,
    val preferredDateRange: String?,
    val estimatedWaitMin: Int?,
    val notes: String?,
)
