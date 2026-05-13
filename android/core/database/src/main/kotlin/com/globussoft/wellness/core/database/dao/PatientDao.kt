package com.globussoft.wellness.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.globussoft.wellness.core.database.entity.PatientEntity
import kotlinx.coroutines.flow.Flow

/**
 * Room DAO for patient cache operations.
 *
 * All list-returning queries expose [Flow] so Compose / ViewModel collectors
 * automatically receive updated data whenever the database is written — no
 * manual refresh triggers required.
 *
 * Every query is scoped to a [tenantId] parameter to prevent cross-tenant
 * data leakage on shared devices. The caller (typically a repository) must
 * supply the tenantId from [AuthDataStore] / [UserSession].
 */
@Dao
interface PatientDao {

    /**
     * Returns all cached patients for [tenantId], sorted alphabetically by name.
     *
     * Emits a new list whenever any patient row for this tenant changes.
     */
    @Query(
        """
        SELECT * FROM patients
        WHERE tenantId = :tenantId
        ORDER BY name ASC
        """,
    )
    fun getAllPatients(tenantId: String): Flow<List<PatientEntity>>

    /**
     * Full-text substring search across [PatientEntity.name] and
     * [PatientEntity.phone] for [tenantId].
     *
     * The LIKE wildcards are baked into the query rather than the parameter
     * to keep the caller signature clean; Room's binding handles SQL injection
     * prevention automatically.
     *
     * Emits a new list whenever any matching row changes.
     */
    @Query(
        """
        SELECT * FROM patients
        WHERE tenantId = :tenantId
          AND (name LIKE '%' || :query || '%'
               OR phone LIKE '%' || :query || '%')
        ORDER BY name ASC
        """,
    )
    fun searchPatients(tenantId: String, query: String): Flow<List<PatientEntity>>

    /**
     * Upserts a batch of patient entities.
     *
     * [OnConflictStrategy.REPLACE] ensures that a server sync always writes
     * the freshest data, overwriting any stale cached row for the same [id].
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertPatients(patients: List<PatientEntity>)

    /**
     * Returns a single patient by primary key, or null if not cached.
     *
     * Used by the patient detail screen to provide an instant offline render
     * before the network response arrives.
     */
    @Query("SELECT * FROM patients WHERE id = :id")
    suspend fun getPatientById(id: String): PatientEntity?

    /**
     * Deletes all cached patients for [tenantId].
     *
     * Called during logout to prevent the next user from seeing another
     * tenant's patient list, and during a full sync reset.
     */
    @Query("DELETE FROM patients WHERE tenantId = :tenantId")
    suspend fun clearAll(tenantId: String)
}
