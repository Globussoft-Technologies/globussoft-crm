package com.globussoft.wellness.core.database.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Room entity for the today's calendar visit cache.
 *
 * Indexed on [tenantId] + [visitDate] because the primary query pattern is
 * "give me all visits for tenant X on date Y" (the calendar day-grid view).
 * A secondary index on [patientId] supports fast patient-timeline lookups
 * from the patient detail screen without a network round-trip.
 *
 * [visitDate] is stored as an ISO-8601 datetime string
 * (e.g. "2026-05-13T10:30:00.000Z") so Room's SQLite `date()` function can
 * extract the date component for the DAOs' date-equality predicates.
 *
 * [status] and [bookingType] are stored as plain strings — Room does not natively
 * support Kotlin enums, and using @TypeConverter for a cached-only model adds
 * unnecessary complexity. Callers use the mapper layer to convert to domain enums.
 */
@Entity(
    tableName = "visits",
    indices = [
        Index(value = ["tenantId", "visitDate"]),
        Index(value = ["patientId"]),
    ],
)
data class VisitEntity(
    @PrimaryKey
    val id: String,
    val tenantId: String,
    val patientId: String,
    val patientName: String?,
    val doctorId: String?,
    val doctorName: String?,
    val serviceId: String?,
    val serviceName: String?,
    val locationId: String?,
    val visitDate: String,
    val status: String,
    val bookingType: String,
    val travelTimeMinutes: Int?,
    val notes: String?,
    val amount: Double?,
    val duration: Int?,
    val createdAt: String,
    val syncedAt: Long = System.currentTimeMillis(),
)
