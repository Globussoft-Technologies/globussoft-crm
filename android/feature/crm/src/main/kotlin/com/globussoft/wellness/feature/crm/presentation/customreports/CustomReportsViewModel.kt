package com.globussoft.wellness.feature.crm.presentation.customreports

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
class CustomReportsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(CustomReportsUiState())
    val state: StateFlow<CustomReportsUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    fun showCreate() = _state.update { it.copy(showCreateForm = true, formError = null) }
    fun dismissCreate() = _state.update { it.copy(showCreateForm = false, formError = null) }

    fun createReport(name: String, entityType: String) {
        viewModelScope.launch {
            _state.update { it.copy(isCreating = true, formError = null) }
            if (name.isBlank()) {
                _state.update { it.copy(isCreating = false, formError = "Report name is required") }
                return@launch
            }
            val result = repo.createCustomReport(name = name, entityType = entityType)
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isCreating = false, showCreateForm = false)
                    is WResult.Error   -> current.copy(isCreating = false, formError = result.message ?: result.exception.message)
                    WResult.Loading    -> current
                }
            }
            if (result is WResult.Success) load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val result = repo.getCustomReports()
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isLoading = false, reports = result.data)
                    is WResult.Error   -> current.copy(isLoading = false, error = result.message ?: result.exception.message ?: "Failed to load reports")
                    WResult.Loading    -> current.copy(isLoading = true)
                }
            }
        }
    }
}
