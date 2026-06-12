package com.globus.crm.feature.health.domain.model

data class Prescription(
    val id: Int,
    val visitId: Int?,
    val visitDate: String?,
    val doctorName: String?,
    val serviceName: String?,
    val drugs: List<Drug>,
    val pdfBytes: ByteArray? = null,
    val pdfCachedAt: Long? = null,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Prescription) return false
        return id == other.id && visitId == other.visitId
    }

    override fun hashCode(): Int = 31 * id + (visitId ?: 0)
}

data class Drug(
    val name: String,
    val dosage: String?,
    val frequency: String?,
    val duration: String?,
    val instructions: String?,
)
