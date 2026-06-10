package com.globus.crm.feature.notifications.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.feature.notifications.domain.usecase.GetNotificationsUseCase
import com.globus.crm.feature.notifications.domain.usecase.MarkNotificationReadUseCase
import com.globus.crm.feature.notifications.domain.usecase.SyncPortalNotificationsUseCase
import com.globus.crm.feature.notifications.presentation.state.NotificationsUiEvent
import com.globus.crm.feature.notifications.presentation.state.NotificationsUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class NotificationsNavEvent {
    data class OpenDeepLink(val screen: String, val entityId: String?) : NotificationsNavEvent()
    object Back : NotificationsNavEvent()
}

@HiltViewModel
class NotificationsViewModel @Inject constructor(
    private val getNotifications: GetNotificationsUseCase,
    private val markRead: MarkNotificationReadUseCase,
    private val syncPortalNotifications: SyncPortalNotificationsUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(NotificationsUiState())
    val uiState: StateFlow<NotificationsUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<NotificationsNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        load()
        viewModelScope.launch { syncPortalNotifications() }
    }

    private fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true)
            getNotifications().collect { list ->
                _uiState.value = NotificationsUiState(isLoading = false, notifications = list)
            }
        }
    }

    fun onEvent(event: NotificationsUiEvent) {
        when (event) {
            NotificationsUiEvent.Refresh -> {
                load()
                viewModelScope.launch { syncPortalNotifications() }
            }
            is NotificationsUiEvent.MarkRead -> viewModelScope.launch { markRead(event.notificationId) }
            NotificationsUiEvent.MarkAllRead -> viewModelScope.launch { markRead.markAll() }
            is NotificationsUiEvent.TapNotification -> {
                viewModelScope.launch {
                    markRead(event.notification.id)
                    if (!event.notification.screen.isNullOrBlank()) {
                        _navEvent.send(NotificationsNavEvent.OpenDeepLink(event.notification.screen, event.notification.entityId))
                    }
                }
            }
            NotificationsUiEvent.NavigateBack -> viewModelScope.launch { _navEvent.send(NotificationsNavEvent.Back) }
        }
    }
}
