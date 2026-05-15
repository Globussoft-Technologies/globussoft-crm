package com.globussoft.wellness.feature.crm.presentation.settings

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

@HiltViewModel
class CrmSettingsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(CrmSettingsUiState())
    val state: StateFlow<CrmSettingsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun refresh() = load()

    fun saveSettings(currency: String, timezone: String) {
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true, saveError = null) }
            val result = repo.saveSettings(mapOf(
                "currency" to currency,
                "timezone" to timezone,
            ))
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isSaving = false, settings = result.data)
                    is WResult.Error   -> current.copy(isSaving = false, saveError = result.message ?: result.exception.message)
                    WResult.Loading    -> current
                }
            }
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repo.getSettings()) {
                is WResult.Success -> _state.update {
                    it.copy(isLoading = false, settings = result.data, error = null)
                }
                is WResult.Error   -> _state.update {
                    it.copy(
                        isLoading = false,
                        error = result.message ?: result.exception.message ?: "Failed to load settings",
                    )
                }
                WResult.Loading    -> Unit
            }
        }
    }
}
