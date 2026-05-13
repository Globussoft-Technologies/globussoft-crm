package com.globussoft.wellness.core.network.model.request

/**
 * Request body for POST /api/wellness/patients and PUT /api/wellness/patients/{id}.
 *
 * Nullable fields are omitted from the JSON payload when null, allowing the
 * same DTO for both create and update (PUT replaces all provided fields).
 *
 * [locationId] — foreign key to the clinic branch; null means no specific
 *                location is assigned (floater / unassigned patient).
 */
data class CreatePatientRequest(
    val name: String,
    val phone: String,
    val email: String?,
    val dob: String?,
    val gender: String?,
    val source: String?,
    val locationId: String?,
)
