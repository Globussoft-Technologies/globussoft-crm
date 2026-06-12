package com.globus.crm.feature.notifications.presentation.state

import com.globus.crm.feature.notifications.domain.model.Notification

data class NotificationsUiState(
    val notifications: List<Notification> = emptyList(),
    val isLoading: Boolean = true,
)

sealed class NotificationsUiEvent {
    object Refresh : NotificationsUiEvent()
    data class MarkRead(val notificationId: String) : NotificationsUiEvent()
    object MarkAllRead : NotificationsUiEvent()
    data class TapNotification(val notification: Notification) : NotificationsUiEvent()
    object NavigateBack : NotificationsUiEvent()
}
