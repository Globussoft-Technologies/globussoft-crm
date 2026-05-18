package com.globussoft.wellness.core.domain.model

/**
 * A wellness-vertical patient record.
 *
 * [visitsCount], [rxCount], [treatmentPlanCount] are denormalised counts
 * populated by the server on list/detail reads to avoid extra round-trips.
 */
data class Patient(
    val id: String,
    val name: String,
    val phone: String,
    val email: String?,
    val dob: String?,
    val age: Int?,
    val gender: String?,
    val bloodGroup: String?,
    val source: String?,
    val locationId: String?,
    val createdAt: String?,
    val visitsCount: Int = 0,
    val rxCount: Int = 0,
    val treatmentPlanCount: Int = 0,
)

/**
 * Mutable form state for creating or updating a [Patient].
 *
 * All optional fields default to empty string so the Compose form layer
 * can bind them without null-checks; the repository layer omits blank
 * fields before sending to the API.
 */
data class PatientForm(
    val name: String,
    val phone: String,
    val email: String = "",
    val dob: String = "",
    val gender: String = "",
    val source: String = "",
    val locationId: String = "",
)
