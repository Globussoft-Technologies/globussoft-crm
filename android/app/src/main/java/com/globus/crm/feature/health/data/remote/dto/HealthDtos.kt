package com.globus.crm.feature.health.data.remote.dto

import com.squareup.moshi.JsonClass

// GET /portal/prescriptions — backend stores drugs as a JSON-encoded string, not an array.
// visit/doctor are nested objects returned by the API.
@JsonClass(generateAdapter = true)
data class PrescriptionDto(
    val id: Int,
    val visitId: Int?,
    val drugs: String,
    val instructions: String?,
    val pdfUrl: String?,
    val visit: PrescriptionVisitDto?,
    val doctor: PrescriptionDoctorDto?,
    val createdAt: String?,
)

@JsonClass(generateAdapter = true)
data class PrescriptionVisitDto(
    val id: Int,
    val visitDate: String?,
    val service: PrescriptionServiceDto?,
)

@JsonClass(generateAdapter = true)
data class PrescriptionServiceDto(
    val name: String,
)

@JsonClass(generateAdapter = true)
data class PrescriptionDoctorDto(
    val id: Int,
    val name: String?,
)

data class DrugDto(
    val name: String,
    val dosage: String?,
    val frequency: String?,
    val duration: String?,
    val instructions: String?,
)

// GET /api/wellness/patients/{patientId}/treatment-plans — CUSTOMER JWT (verifyToken).
// Real shape confirmed against staging 2026-06-04.
@JsonClass(generateAdapter = true)
data class TreatmentPlanDto(
    val id: Int,
    val name: String,
    val totalSessions: Int,
    val completedSessions: Int,
    val startedAt: String,
    val nextDueAt: String?,
    val status: String,
    val totalPrice: Double,
    val patientId: Int,
    val serviceId: Int,
    val tenantId: Int,
    val patient: TreatmentPatientRefDto?,
    val service: TreatmentServiceRefDto?,
)

@JsonClass(generateAdapter = true)
data class TreatmentPatientRefDto(
    val id: Int,
    val name: String,
    val phone: String?,
)

@JsonClass(generateAdapter = true)
data class TreatmentServiceRefDto(
    val id: Int,
    val name: String,
    val category: String?,
)

// GET /api/wellness/patients/{patientId}/consents — CUSTOMER JWT (verifyToken).
// Real shape confirmed against staging 2026-06-04.
@JsonClass(generateAdapter = true)
data class ConsentFormDto(
    val id: Int,
    val templateName: String,
    val signedAt: String,
    val patientId: Int,
    val serviceId: Int,
    val hasPdfBlob: Boolean,
    val patient: ConsentPatientRefDto?,
    val service: ConsentServiceRefDto?,
)

@JsonClass(generateAdapter = true)
data class ConsentPatientRefDto(
    val id: Int,
    val name: String,
)

@JsonClass(generateAdapter = true)
data class ConsentServiceRefDto(
    val id: Int,
    val name: String,
)
