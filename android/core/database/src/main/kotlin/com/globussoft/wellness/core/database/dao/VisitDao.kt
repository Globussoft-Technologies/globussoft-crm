package com.globussoft.wellness.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.globussoft.wellness.core.database.entity.VisitEntity
import kotlinx.coroutines.flow.Flow

/**
 * Room DAO for visit / appointment cache operations.
 *
 * The primary access pattern is "all visits for a given calendar date" which
 * drives the day-grid view on the Calendar screen. SQLite's built-in `date()`
 * function extracts the date component from the stored ISO-8601 [VisitEntity.visitDate]
 * string for the equality comparison.
 *
 * [tenantId] scoping is mandatory on every query — see [PatientDao] for the
 * rationale.
 */
@Dao
interface VisitDao {

    /**
     * Returns all cached visits for [tenantId] on the given ISO-8601 [date]
     * string (e.g. "2026-05-13"), sorted chronologically by [VisitEntity.visitDate].
     *
     * Emits a new list whenever any visit row for this tenant/date combination
     * is inserted, updated, or deleted.
     */
    @Query(
        """
        SELECT * FROM visits
        WHERE tenantId = :tenantId
          AND date(visitDate) = :date
        ORDER BY visitDate ASC
        """,
    )
    fun getVisitsForDate(tenantId: String, date: String): Flow<List<VisitEntity>>

    /**
     * Upserts a batch of visit entities.
     *
     * [OnConflictStrategy.REPLACE] ensures server-synced data always wins over
     * any locally cached row for the same visit [id].
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertVisits(visits: List<VisitEntity>)

    /**
     * Deletes all cached visits for [tenantId] on the given ISO-8601 [date].
     *
     * Called before a fresh sync write to avoid accumulating stale visits on
     * dates where the server has since cancelled or rescheduled appointments.
     */
    @Query(
        """
        DELETE FROM visits
        WHERE tenantId = :tenantId
          AND date(visitDate) = :date
        """,
    )
    suspend fun clearVisitsForDate(tenantId: String, date: String)
}
