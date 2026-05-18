package com.globussoft.wellness.core.domain.model

/**
 * A single prescription written by a doctor during or after a visit.
 *
 * [drugs] is the structured list of medications. [instructions] is optional
 * free-text (e.g. "Take after meals, avoid alcohol").
 */
data class Prescription(
    val id: String,
    val patientId: String,
    val visitId: String,
    val doctorName: String?,
    val drugs: List<DrugItem>,
    val instructions: String?,
    val createdAt: String?,
)

/** A single medication line within a [Prescription]. */
data class DrugItem(
    val name: String,
    val dosage: String? = null,
    val frequency: String? = null,
    val duration: String? = null,
)
