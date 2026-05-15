package com.globussoft.wellness.feature.crm.presentation.approvals

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
class ApprovalsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ApprovalsUiState())
    val state: StateFlow<ApprovalsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun selectTab(index: Int) {
        _state.update { it.copy(selectedTab = index) }
        load()
    }

    fun approve(id: String, comment: String? = null) {
        viewModelScope.launch {
            when (val result = repo.approveApproval(id, comment)) {
                is WResult.Success -> load()
                is WResult.Error   -> _state.update {
                    it.copy(error = result.message ?: result.exception.message ?: "Failed to approve")
                }
                WResult.Loading    -> Unit
            }
        }
    }

    fun reject(id: String, comment: String? = null) {
        viewModelScope.launch {
            when (val result = repo.rejectApproval(id, comment)) {
                is WResult.Success -> load()
                is WResult.Error   -> _state.update {
                    it.copy(error = result.message ?: result.exception.message ?: "Failed to reject")
                }
                WResult.Loading    -> Unit
            }
        }
    }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }

            val tab    = _state.value.selectedTab
            val result = when (tab) {
                0    -> repo.getApprovals(mine = true)
                1    -> repo.getApprovals(status = "PENDING")
                else -> repo.getApprovals()
            }

            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(
                        isLoading = false,
                        approvals = result.data,
                        error     = null,
                    )
                    is WResult.Error   -> current.copy(
                        isLoading = false,
                        error     = result.message ?: result.exception.message ?: "Failed to load approvals",
                    )
                    WResult.Loading    -> current.copy(isLoading = true)
                }
            }
        }
    }
}
