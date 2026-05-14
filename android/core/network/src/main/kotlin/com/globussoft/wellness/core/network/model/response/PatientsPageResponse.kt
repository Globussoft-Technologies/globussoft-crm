package com.globussoft.wellness.core.network.model.response

/**
 * Paginated patients response as returned by GET /api/wellness/patients.
 *
 * [patients] — the current page of patient records.
 * [total]    — total number of matching records across all pages.
 */
data class PatientsPageResponse(
    val patients: List<PatientResponse>,
    val total: Int,
)
