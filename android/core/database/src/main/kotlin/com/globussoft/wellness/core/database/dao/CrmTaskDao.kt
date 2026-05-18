package com.globussoft.wellness.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.globussoft.wellness.core.database.entity.CrmTaskEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface CrmTaskDao {

    @Query(
        """
        SELECT * FROM crm_tasks
        WHERE tenantId = :tenantId
          AND (:status IS NULL OR status = :status)
        ORDER BY
          CASE WHEN dueDate IS NULL THEN 1 ELSE 0 END,
          dueDate ASC
        """,
    )
    fun getTasks(
        tenantId: String,
        status: String? = null,
    ): Flow<List<CrmTaskEntity>>

    @Query("SELECT * FROM crm_tasks WHERE id = :id")
    suspend fun getTaskById(id: String): CrmTaskEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertTasks(tasks: List<CrmTaskEntity>)

    @Query("UPDATE crm_tasks SET status = 'COMPLETED' WHERE id = :id")
    suspend fun markCompleted(id: String)

    @Query("DELETE FROM crm_tasks WHERE tenantId = :tenantId")
    suspend fun clearAll(tenantId: String)
}
