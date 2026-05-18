package com.globussoft.wellness.navigation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class NotificationsUiState(
    val notifications: List<Map<String, Any>> = emptyList(),
    val unreadCount: Int = 0,
    val isLoading: Boolean = false,
)

@HiltViewModel
class NotificationsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(NotificationsUiState())
    val state: StateFlow<NotificationsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }
            val result = repo.getNotificationsFeed()
            if (result is WResult.Success) {
                val notifs = result.data
                val unread = notifs.count { (it["read"] as? Boolean) == false }
                _state.update {
                    it.copy(
                        notifications = notifs,
                        unreadCount   = unread,
                        isLoading     = false,
                    )
                }
            } else {
                _state.update { it.copy(isLoading = false) }
            }
        }
    }
}
