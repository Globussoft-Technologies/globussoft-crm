package com.globussoft.wellness.core.database.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Room entity for the offline patient cache.
 *
 * Indexed on [tenantId] + [name] and [tenantId] + [phone] to support the
 * two search axes used by the patient list screen without full table scans.
 *
 * [tenantId] is stored on every row so the DAOs can scope all queries to the
 * current tenant — critical for multi-tenant installations where more than one
 * account may be cached on the same device.
 *
 * [syncedAt] — epoch milliseconds of the last successful server sync for this
 *              record; used by the repository to implement a stale-while-revalidate
 *              caching strategy (re-fetch when syncedAt is older than the TTL).
 */
@Entity(
    tableName = "patients",
    indices = [
        Index(value = ["tenantId", "name"]),
        Index(value = ["tenantId", "phone"]),
    ],
)
data class PatientEntity(
    @PrimaryKey
    val id: String,
    val tenantId: String,
    val name: String,
    val phone: String,
    val email: String?,
    val dob: String?,
    val gender: String?,
    val bloodGroup: String?,
    val source: String?,
    val locationId: String?,
    val createdAt: String,
    val visitsCount: Int = 0,
    val rxCount: Int = 0,
    val treatmentPlanCount: Int = 0,
    val syncedAt: Long = System.currentTimeMillis(),
)
