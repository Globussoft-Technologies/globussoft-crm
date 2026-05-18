package com.globussoft.wellness.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.globussoft.wellness.core.database.entity.CrmContactEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface CrmContactDao {

    @Query(
        """
        SELECT * FROM crm_contacts
        WHERE tenantId = :tenantId
          AND (:status IS NULL OR status = :status)
          AND (:query = '' OR name LIKE '%' || :query || '%'
               OR email LIKE '%' || :query || '%'
               OR phone LIKE '%' || :query || '%')
        ORDER BY name ASC
        """,
    )
    fun getContacts(
        tenantId: String,
        status: String? = null,
        query: String = "",
    ): Flow<List<CrmContactEntity>>

    @Query("SELECT * FROM crm_contacts WHERE id = :id")
    suspend fun getContactById(id: String): CrmContactEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertContacts(contacts: List<CrmContactEntity>)

    @Query("DELETE FROM crm_contacts WHERE tenantId = :tenantId")
    suspend fun clearAll(tenantId: String)
}
