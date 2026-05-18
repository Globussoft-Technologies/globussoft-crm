package com.globussoft.wellness.feature.admin.presentation.memberships

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.MembershipPlanItem
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class MembershipsUiState(
    val isLoading: Boolean = false,
    val plans: List<MembershipPlanItem> = emptyList(),
    val error: String? = null,
    val showEnrollSheet: Boolean = false,
    val selectedPlanId: String? = null,
    val isEnrolling: Boolean = false,
)

@HiltViewModel
class MembershipsViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(MembershipsUiState())
    val state: StateFlow<MembershipsUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    fun showEnroll(planId: String) = _state.update { it.copy(showEnrollSheet = true, selectedPlanId = planId) }
    fun dismissEnroll()            = _state.update { it.copy(showEnrollSheet = false, selectedPlanId = null) }

    fun enrollPatient(patientId: String) {
        val planId = _state.value.selectedPlanId ?: return
        viewModelScope.launch {
            _state.update { it.copy(isEnrolling = true) }
            repository.enrollMembership(patientId, planId)
            _state.update { it.copy(isEnrolling = false, showEnrollSheet = false, selectedPlanId = null) }
            load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getMembershipPlans()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, plans = r.data) }
                is WResult.Error   -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load membership plans"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}
