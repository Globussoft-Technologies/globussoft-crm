package com.globussoft.wellness.feature.admin.presentation.auditlog

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.AuditLogItem
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class AuditLogUiState(
    val isLoading: Boolean = false,
    val logs: List<AuditLogItem> = emptyList(),
    val error: String? = null,
    val currentPage: Int = 1,
    val totalPages: Int = 1,
    val isLoadingMore: Boolean = false,
)

@HiltViewModel
class AuditLogViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(AuditLogUiState())
    val state: StateFlow<AuditLogUiState> = _state.asStateFlow()

    init { load(page = 1) }

    fun refresh() = load(page = 1)

    fun loadNextPage() {
        val s = _state.value
        if (s.isLoadingMore || s.currentPage >= s.totalPages) return
        load(page = s.currentPage + 1, append = true)
    }

    private fun load(page: Int, append: Boolean = false) {
        viewModelScope.launch {
            if (append) {
                _state.update { it.copy(isLoadingMore = true) }
            } else {
                _state.update { it.copy(isLoading = true, error = null) }
            }
            when (val r = repository.getAuditLogs(page)) {
                is WResult.Success -> _state.update { s ->
                    s.copy(
                        isLoading    = false,
                        isLoadingMore = false,
                        logs         = if (append) s.logs + r.data.logs else r.data.logs,
                        currentPage  = r.data.currentPage,
                        totalPages   = r.data.pages,
                    )
                }
                is WResult.Error -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load audit log"
                    _state.update { it.copy(isLoading = false, isLoadingMore = false, error = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}
