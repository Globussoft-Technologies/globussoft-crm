package com.globussoft.wellness.feature.admin.presentation.commissionprofiles

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.CommissionProfileItem
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class CommissionProfilesUiState(
    val isLoading: Boolean = false,
    val profiles: List<CommissionProfileItem> = emptyList(),
    val error: String? = null,
)

@HiltViewModel
class CommissionProfilesViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(CommissionProfilesUiState())
    val state: StateFlow<CommissionProfilesUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getCommissionProfiles()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, profiles = r.data) }
                is WResult.Error   -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load commission profiles"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}
