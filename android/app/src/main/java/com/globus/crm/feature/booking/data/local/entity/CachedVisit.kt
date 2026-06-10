package com.globus.crm.feature.booking.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "cached_visits")
data class CachedVisit(
    @PrimaryKey val id: Int,
    val visitDate: Long,
    val status: String,
    val serviceName: String?,
    val doctorName: String?,
    val locationName: String?,
    val bookingType: String?,
    val videoCallUrl: String?,
    val amountCharged: Double?,
    val cachedAt: Long,
)
