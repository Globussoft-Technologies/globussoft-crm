package com.globus.crm.feature.notifications.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "cached_notifications")
data class CachedNotification(
    @PrimaryKey val id: String,
    val type: String,
    val title: String,
    val body: String,
    val screen: String?,
    val entityId: String?,
    val isRead: Boolean = false,
    val receivedAt: Long,
)
