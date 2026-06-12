package com.globus.crm.feature.health.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.globus.crm.feature.health.data.local.entity.CachedPrescription

@Dao
interface PrescriptionDao {

    @Query("SELECT * FROM cached_prescriptions ORDER BY visitDate DESC")
    suspend fun getAll(): List<CachedPrescription>

    @Query("SELECT * FROM cached_prescriptions WHERE id = :id")
    suspend fun getById(id: Int): CachedPrescription?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(prescriptions: List<CachedPrescription>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(prescription: CachedPrescription)

    @Query("UPDATE cached_prescriptions SET pdfBytes = NULL, pdfCachedAt = NULL WHERE pdfCachedAt < :olderThanMs")
    suspend fun evictStalePdfs(olderThanMs: Long)

    @Query("DELETE FROM cached_prescriptions")
    suspend fun deleteAll()
}
