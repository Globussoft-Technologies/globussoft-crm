package com.globus.crm.feature.health.data.mapper

import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.health.data.local.entity.CachedPrescription
import com.globus.crm.feature.health.data.remote.dto.ConsentFormDto
import com.globus.crm.feature.health.data.remote.dto.DrugDto
import com.globus.crm.feature.health.data.remote.dto.PrescriptionDto
import com.globus.crm.feature.health.data.remote.dto.TreatmentPlanDto
import com.globus.crm.feature.health.domain.model.ConsentForm
import com.globus.crm.feature.health.domain.model.Drug
import com.globus.crm.feature.health.domain.model.Prescription
import com.globus.crm.feature.health.domain.model.TreatmentPlan

fun PrescriptionDto.toDomain() = Prescription(
    id = id,
    visitId = visitId,
    visitDate = visit?.visitDate,
    doctorName = doctor?.name,
    serviceName = visit?.service?.name,
    drugs = parseDrugsJson(drugs),
)

private fun parseDrugsJson(json: String): List<Drug> = try {
    val arr = org.json.JSONArray(json)
    (0 until arr.length()).map { i ->
        val obj = arr.getJSONObject(i)
        Drug(
            name = obj.optString("name"),
            dosage = obj.optString("dosage").ifEmpty { null },
            frequency = obj.optString("frequency").ifEmpty { null },
            duration = obj.optString("duration").ifEmpty { null },
            instructions = obj.optString("instructions").ifEmpty { null },
        )
    }
} catch (_: Exception) {
    emptyList()
}

fun CachedPrescription.toDomain() = Prescription(
    id = id,
    visitId = visitId,
    visitDate = if (visitDate > 0L) DateUtil.epochMsToIso(visitDate) else null,
    doctorName = doctorName,
    serviceName = serviceName,
    drugs = emptyList(),
    pdfBytes = pdfBytes,
    pdfCachedAt = pdfCachedAt,
)

fun Prescription.toEntity() = CachedPrescription(
    id = id,
    visitId = visitId,
    visitDate = DateUtil.isoToEpochMs(visitDate),
    doctorName = doctorName,
    serviceName = serviceName,
    drugCount = drugs.size,
    pdfBytes = pdfBytes,
    pdfCachedAt = pdfCachedAt,
    cachedAt = System.currentTimeMillis(),
)

fun TreatmentPlanDto.toDomain() = TreatmentPlan(
    id = id,
    name = name,
    totalSessions = totalSessions,
    completedSessions = completedSessions,
    startedAt = startedAt,
    nextDueAt = nextDueAt,
    status = status,
    totalPrice = totalPrice,
    serviceName = service?.name,
    serviceCategory = service?.category,
)

fun ConsentFormDto.toDomain() = ConsentForm(
    id = id,
    templateName = templateName,
    signedAt = signedAt,
    hasPdfBlob = hasPdfBlob,
    serviceName = service?.name,
)
