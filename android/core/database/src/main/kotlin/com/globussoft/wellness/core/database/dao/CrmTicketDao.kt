package com.globussoft.wellness.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.globussoft.wellness.core.database.entity.CrmTicketEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface CrmTicketDao {

    @Query(
        """
        SELECT * FROM crm_tickets
        WHERE tenantId = :tenantId
          AND (:status IS NULL OR status = :status)
          AND (:priority IS NULL OR priority = :priority)
        ORDER BY
          slaBreached DESC,
          createdAt DESC
        """,
    )
    fun getTickets(
        tenantId: String,
        status: String? = null,
        priority: String? = null,
    ): Flow<List<CrmTicketEntity>>

    @Query("SELECT * FROM crm_tickets WHERE id = :id")
    suspend fun getTicketById(id: String): CrmTicketEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertTickets(tickets: List<CrmTicketEntity>)

    @Query("DELETE FROM crm_tickets WHERE tenantId = :tenantId")
    suspend fun clearAll(tenantId: String)
}
