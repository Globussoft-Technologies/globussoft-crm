package com.globussoft.wellness.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.globussoft.wellness.core.database.entity.CrmDealEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface CrmDealDao {

    @Query(
        """
        SELECT * FROM crm_deals
        WHERE tenantId = :tenantId
          AND (:status IS NULL OR status = :status)
          AND (:stage IS NULL OR stage = :stage)
        ORDER BY createdAt DESC
        """,
    )
    fun getDeals(
        tenantId: String,
        status: String? = null,
        stage: String? = null,
    ): Flow<List<CrmDealEntity>>

    @Query("SELECT * FROM crm_deals WHERE id = :id")
    suspend fun getDealById(id: String): CrmDealEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertDeals(deals: List<CrmDealEntity>)

    @Query("DELETE FROM crm_deals WHERE tenantId = :tenantId")
    suspend fun clearAll(tenantId: String)
}
