package com.globussoft.wellness.core.network.model.response

/**
 * Patient record as returned by the Wellness CRM API.
 *
 * [_count] — Prisma aggregation object included on list and detail reads;
 *            holds denormalised sub-record counts to avoid extra round-trips.
 */
data class PatientResponse(
    val id: String,
    val name: String,
    val phone: String?,
    val email: String?,
    val dob: String?,
    val gender: String?,
    val bloodGroup: String?,
    val source: String?,
    val locationId: String?,
    val createdAt: String?,
    val _count: PatientCountResponse?,
)

/**
 * Denormalised sub-record counts attached to [PatientResponse].
 *
 * Matches the Prisma `_count` select shape from the backend route handler.
 */
data class PatientCountResponse(
    val visits: Int,
    val prescriptions: Int,
    val treatmentPlans: Int,
)
