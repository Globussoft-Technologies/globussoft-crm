package com.globussoft.wellness.feature.crm.presentation.auditlog

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
class AuditLogViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(AuditLogUiState())
    val state: StateFlow<AuditLogUiState> = _state.asStateFlow()

    init {
        load(page = 1)
    }

    fun setEntityType(entityType: String?) {
        _state.update { it.copy(selectedEntityType = entityType, logs = emptyList(), currentPage = 1) }
        load(page = 1)
    }

    fun setAction(action: String?) {
        _state.update { it.copy(selectedAction = action, logs = emptyList(), currentPage = 1) }
        load(page = 1)
    }

    fun loadNextPage() {
        val current = _state.value
        if (current.currentPage < current.totalPages && !current.isLoading) {
            load(page = current.currentPage + 1, append = true)
        }
    }

    fun refresh() {
        _state.update { it.copy(currentPage = 1, logs = emptyList()) }
        load(page = 1)
    }

    @Suppress("UNCHECKED_CAST")
    private fun load(page: Int, append: Boolean = false) {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repo.getAuditLogs(page = page, entityType = _state.value.selectedEntityType, action = _state.value.selectedAction)) {
                is WResult.Success -> {
                    val data       = result.data
                    val logs       = data["logs"] as? List<Map<String, Any>> ?: emptyList()
                    val totalPages = (data["totalPages"] as? Number)?.toInt() ?: 1
                    _state.update { current ->
                        current.copy(
                            isLoading   = false,
                            logs        = if (append) current.logs + logs else logs,
                            totalPages  = totalPages,
                            currentPage = page,
                            error       = null,
                        )
                    }
                }
                is WResult.Error   -> _state.update {
                    it.copy(
                        isLoading = false,
                        error = result.message ?: result.exception.message ?: "Failed to load audit logs",
                    )
                }
                WResult.Loading    -> Unit
            }
        }
    }
}
