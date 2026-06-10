package com.globus.crm.feature.notifications.domain.repository

import com.globus.crm.feature.notifications.domain.model.Notification
import kotlinx.coroutines.flow.Flow

interface NotificationRepository {
    fun getNotificationsAsFlow(): Flow<List<Notification>>
    suspend fun markRead(notificationId: String)
    suspend fun markAllRead()
    suspend fun deleteOldNotifications()
    suspend fun insert(notification: Notification)
}
