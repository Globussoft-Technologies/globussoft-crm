package com.globus.crm.feature.notifications.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.globus.crm.feature.notifications.data.local.entity.CachedNotification
import kotlinx.coroutines.flow.Flow

@Dao
interface NotificationDao {

    @Query("SELECT * FROM cached_notifications ORDER BY receivedAt DESC")
    fun getAllAsFlow(): Flow<List<CachedNotification>>

    @Query("SELECT * FROM cached_notifications ORDER BY receivedAt DESC")
    suspend fun getAll(): List<CachedNotification>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(notification: CachedNotification)

    @Query("UPDATE cached_notifications SET isRead = 1 WHERE id = :id")
    suspend fun markRead(id: String)

    @Query("UPDATE cached_notifications SET isRead = 1")
    suspend fun markAllRead()

    @Query("DELETE FROM cached_notifications WHERE receivedAt < :olderThanMs")
    suspend fun deleteOlderThan(olderThanMs: Long)

    @Query("DELETE FROM cached_notifications")
    suspend fun deleteAll()

    @Query("SELECT COUNT(*) FROM cached_notifications WHERE isRead = 0")
    fun getUnreadCountAsFlow(): Flow<Int>
}
