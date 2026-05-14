package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Patient
import com.globussoft.wellness.core.domain.model.PatientForm
import com.globussoft.wellness.core.network.model.request.CreatePatientRequest
import com.globussoft.wellness.core.network.model.response.PatientResponse

/**
 * Maps a [PatientResponse] network DTO to the [Patient] domain model.
 *
 * [_count] sub-fields are mapped to denormalised counts on the domain model;
 * they default to 0 when the backend omits the include clause (e.g. lightweight
 * list queries).
 *
 * Age is not returned by the backend; it is derived locally from [dob] when
 * present. This keeps the domain model self-contained without requiring a
 * server round-trip.
 */
fun PatientResponse.toDomain(): Patient = Patient(
    id               = id,
    name             = name,
    phone            = phone ?: "",
    email            = email,
    dob              = dob,
    age              = dob?.let { computeAgeFromDob(it) },
    gender           = gender,
    bloodGroup       = bloodGroup,
    source           = source,
    locationId       = locationId,
    createdAt        = createdAt,
    visitsCount      = _count?.visits ?: 0,
    rxCount          = _count?.prescriptions ?: 0,
    treatmentPlanCount = _count?.treatmentPlans ?: 0,
)

/**
 * Maps a [PatientForm] UI state object to the [CreatePatientRequest] DTO
 * that is serialised and sent to POST / PUT /api/wellness/patients.
 *
 * Blank strings are converted to null so the backend validation does not
 * receive empty strings for optional fields.
 */
fun PatientForm.toRequest(): CreatePatientRequest = CreatePatientRequest(
    name       = name,
    phone      = phone,
    email      = email.blankToNull(),
    dob        = dob.blankToNull(),
    gender     = gender.blankToNull(),
    source     = source.blankToNull(),
    locationId = locationId.blankToNull(),
)

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

private fun String.blankToNull(): String? = ifBlank { null }

/**
 * Computes an approximate age in years from a date-of-birth string.
 *
 * Accepts ISO-8601 date strings (e.g. "1990-04-15") and falls back to null
 * for any format that cannot be parsed so the UI can display "—" instead of
 * crashing.
 */
private fun computeAgeFromDob(dob: String): Int? {
    return try {
        val parts = dob.substring(0, 10).split("-")
        if (parts.size < 3) return null
        val birthYear  = parts[0].toInt()
        val birthMonth = parts[1].toInt()
        val birthDay   = parts[2].toInt()
        val today = java.util.Calendar.getInstance()
        val currentYear  = today.get(java.util.Calendar.YEAR)
        val currentMonth = today.get(java.util.Calendar.MONTH) + 1
        val currentDay   = today.get(java.util.Calendar.DAY_OF_MONTH)
        var age = currentYear - birthYear
        if (currentMonth < birthMonth || (currentMonth == birthMonth && currentDay < birthDay)) {
            age--
        }
        if (age < 0) null else age
    } catch (_: Exception) {
        null
    }
}
