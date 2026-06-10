package com.globus.crm.feature.notifications.data.repository

import com.globus.crm.feature.notifications.data.local.dao.NotificationDao
import com.globus.crm.feature.notifications.data.mapper.toDomain
import com.globus.crm.feature.notifications.data.mapper.toEntity
import com.globus.crm.feature.notifications.domain.model.Notification
import com.globus.crm.feature.notifications.domain.repository.NotificationRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class NotificationRepositoryImpl @Inject constructor(
    private val dao: NotificationDao,
) : NotificationRepository {

    override fun getNotificationsAsFlow(): Flow<List<Notification>> =
        dao.getAllAsFlow().map { list -> list.map { it.toDomain() } }

    override suspend fun markRead(notificationId: String) = dao.markRead(notificationId)

    override suspend fun markAllRead() = dao.markAllRead()

    override suspend fun deleteOldNotifications() {
        val ninetyDaysAgo = System.currentTimeMillis() - 90L * 24 * 60 * 60 * 1000
        dao.deleteOlderThan(ninetyDaysAgo)
    }

    override suspend fun insert(notification: Notification) = dao.insert(notification.toEntity())
}
