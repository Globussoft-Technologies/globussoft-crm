package com.globus.crm.feature.booking.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.globus.crm.feature.booking.data.local.entity.CachedVisit

@Dao
interface VisitDao {

    @Query("SELECT * FROM cached_visits ORDER BY visitDate DESC")
    suspend fun getAll(): List<CachedVisit>

    @Query("SELECT * FROM cached_visits WHERE visitDate >= :nowMs ORDER BY visitDate ASC")
    suspend fun getUpcoming(nowMs: Long): List<CachedVisit>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(visits: List<CachedVisit>)

    @Query("DELETE FROM cached_visits")
    suspend fun deleteAll()
}
