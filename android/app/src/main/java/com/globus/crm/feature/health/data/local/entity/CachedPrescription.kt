package com.globus.crm.feature.health.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "cached_prescriptions")
data class CachedPrescription(
    @PrimaryKey val id: Int,
    val visitId: Int?,
    val visitDate: Long,
    val doctorName: String?,
    val serviceName: String?,
    val drugCount: Int,
    val pdfBytes: ByteArray?,
    val pdfCachedAt: Long?,
    val cachedAt: Long,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is CachedPrescription) return false
        return id == other.id &&
            visitId == other.visitId &&
            visitDate == other.visitDate &&
            doctorName == other.doctorName &&
            serviceName == other.serviceName &&
            drugCount == other.drugCount &&
            pdfBytes.contentEquals(other.pdfBytes) &&
            pdfCachedAt == other.pdfCachedAt &&
            cachedAt == other.cachedAt
    }

    override fun hashCode(): Int {
        var result = id
        result = 31 * result + (visitId ?: 0)
        result = 31 * result + visitDate.hashCode()
        result = 31 * result + (doctorName?.hashCode() ?: 0)
        result = 31 * result + (serviceName?.hashCode() ?: 0)
        result = 31 * result + drugCount
        result = 31 * result + (pdfBytes?.contentHashCode() ?: 0)
        result = 31 * result + (pdfCachedAt?.hashCode() ?: 0)
        result = 31 * result + cachedAt.hashCode()
        return result
    }
}

private fun ByteArray?.contentEquals(other: ByteArray?): Boolean {
    if (this == null && other == null) return true
    if (this == null || other == null) return false
    return this.contentEquals(other)
}
