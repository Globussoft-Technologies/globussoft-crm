package com.globus.crm.feature.notifications.domain.usecase

import com.globus.crm.feature.notifications.domain.model.Notification
import com.globus.crm.feature.notifications.domain.repository.NotificationRepository
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject

class GetNotificationsUseCase @Inject constructor(
    private val repository: NotificationRepository,
) {
    operator fun invoke(): Flow<List<Notification>> = repository.getNotificationsAsFlow()
}
