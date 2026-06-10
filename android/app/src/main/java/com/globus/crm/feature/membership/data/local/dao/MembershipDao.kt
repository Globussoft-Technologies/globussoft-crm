package com.globus.crm.feature.membership.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.globus.crm.feature.membership.data.local.entity.CachedMembership

@Dao
interface MembershipDao {

    @Query("SELECT * FROM cached_memberships ORDER BY endDate DESC")
    suspend fun getAll(): List<CachedMembership>

    @Query("SELECT * FROM cached_memberships WHERE status = 'active' ORDER BY endDate ASC")
    suspend fun getActive(): List<CachedMembership>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(memberships: List<CachedMembership>)

    @Query("DELETE FROM cached_memberships")
    suspend fun deleteAll()
}
