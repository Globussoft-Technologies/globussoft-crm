package com.globussoft.wellness.core.network.model.request

/**
 * Request body for POST /api/wellness/telecaller/dispose/{leadId}.
 *
 * [type]               — disposition type string; one of "INTERESTED" | "NOT_INTERESTED"
 *                        | "CALLBACK" | "APPOINTMENT_BOOKED" | "WRONG_NUMBER" | "DND".
 * [notes]              — optional free-text call notes captured by the telecaller.
 * [callbackAt]         — ISO-8601 datetime for a scheduled callback; non-null only
 *                        when [type] is "CALLBACK".
 * [appointmentDetails] — free-text appointment summary; non-null only when [type]
 *                        is "APPOINTMENT_BOOKED".
 */
data class DispositionRequest(
    val type: String,
    val notes: String?,
    val callbackAt: String?,
    val appointmentDetails: String?,
)
