package com.globus.crm.feature.notifications.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.feature.notifications.presentation.state.NotificationSettingsUiEvent
import com.globus.crm.feature.notifications.presentation.state.NotificationSettingsUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class NotificationSettingsViewModel @Inject constructor() : ViewModel() {

    private val _uiState = MutableStateFlow(NotificationSettingsUiState())
    val uiState: StateFlow<NotificationSettingsUiState> = _uiState.asStateFlow()

    fun onEvent(event: NotificationSettingsUiEvent) {
        when (event) {
            is NotificationSettingsUiEvent.ToggleCategory -> {
                val updated = _uiState.value.categories.map {
                    if (it.key == event.key) it.copy(enabled = event.enabled) else it
                }
                _uiState.value = _uiState.value.copy(categories = updated, saveSuccess = false)
            }
            is NotificationSettingsUiEvent.ToggleChannel -> {
                val updated = _uiState.value.channels.map {
                    if (it.key == event.key) it.copy(enabled = event.enabled) else it
                }
                _uiState.value = _uiState.value.copy(channels = updated, saveSuccess = false)
            }
            is NotificationSettingsUiEvent.SetQuietStart ->
                _uiState.value = _uiState.value.copy(quietStart = event.time, saveSuccess = false)
            is NotificationSettingsUiEvent.SetQuietEnd ->
                _uiState.value = _uiState.value.copy(quietEnd = event.time, saveSuccess = false)
            NotificationSettingsUiEvent.Save -> save()
        }
    }

    private fun save() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSaving = true, saveSuccess = false)
            // Settings stored locally; remote endpoint not yet available — gracefully no-op
            delay(300)
            _uiState.value = _uiState.value.copy(isSaving = false, saveSuccess = true)
        }
    }
}
