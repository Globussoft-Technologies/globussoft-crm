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

// ── Prescription renewal / medicine requests ─────────────────────────────
// Data layer ready ahead of the UI, same as Treatment Plans / Consents below.
//
// POST /portal/prescription-requests — raise a renewal against one of the
// patient's OWN prescriptions.
//
// `medicines` is the ONLY optional part that changes the meaning of the
// request: omit it (or send an empty list) and the backend treats it as
// "renew the complete prescription". When present, every name must match a
// medicine already on that prescription — the server re-reads the Rx and
// rejects anything else with 400 MEDICINE_NOT_ON_PRESCRIPTION.
//
// Do NOT send a doctor id: the backend resolves the prescriber from the
// prescription itself and ignores any client claim.
@JsonClass(generateAdapter = true)
data class CreatePrescriptionRequestDto(
    val prescriptionId: Int,
    // Medicine names as shown on the prescription; null/empty = whole Rx.
    val medicines: List<String>? = null,
    // "another 2 months" → 60. Server caps at 365.
    val durationDays: Int? = null,
    // Optional explicit window, YYYY-MM-DD.
    val from: String? = null,
    val to: String? = null,
    val notes: String? = null,
)

// Response of POST /portal/prescription-requests and each item of
// GET /portal/prescription-requests.
//
// `isFullPrescription` is the server's own answer to "did this ask for
// everything?" — prefer it over inspecting requestedDrugs, so the app and the
// clinic admin panel never disagree about what a null list meant.
@JsonClass(generateAdapter = true)
data class PrescriptionRequestDto(
    val id: Int,
    val status: String, // PENDING | ACCEPTED | REJECTED | COMPLETED
    val prescriptionId: Int,
    val patientId: Int,
    val doctorId: Int?,
    val doctorName: String?,
    val isFullPrescription: Boolean,
    val requestedDrugs: List<RequestedDrugDto>?,
    val requestedDurationDays: Int?,
    val requestedFrom: String?,
    val requestedTo: String?,
    val notes: String?,
    // Staff's note on the decision — populated on reject / complete.
    val reviewNote: String?,
    val reviewedAt: String?,
    val createdAt: String?,
    val updatedAt: String?,
)

@JsonClass(generateAdapter = true)
data class RequestedDrugDto(
    val name: String?,
    val dosage: String?,
    val frequency: String?,
    val duration: String?,
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
