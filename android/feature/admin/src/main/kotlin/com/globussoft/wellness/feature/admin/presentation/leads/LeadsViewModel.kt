package com.globussoft.wellness.feature.admin.presentation.leads

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.LeadItem
import com.globussoft.wellness.feature.admin.domain.repository.LeadsPage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class LeadsUiState(
    val isLoading: Boolean = false,
    val leads: List<LeadItem> = emptyList(),
    val totalPages: Int = 1,
    val currentPage: Int = 1,
    val error: String? = null,
    val selectedStatus: String? = null,
    val search: String = "",
)

@HiltViewModel
class LeadsViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(LeadsUiState())
    val state: StateFlow<LeadsUiState> = _state.asStateFlow()

    init { load(reset = true) }

    fun setStatus(status: String?) {
        _state.update { it.copy(selectedStatus = status) }
        load(reset = true)
    }

    fun setSearch(q: String) {
        _state.update { it.copy(search = q) }
        load(reset = true)
    }

    fun loadNextPage() {
        val s = _state.value
        if (s.isLoading || s.currentPage >= s.totalPages) return
        load(reset = false)
    }

    fun refresh() = load(reset = true)

    private fun load(reset: Boolean) {
        val s = _state.value
        val page = if (reset) 1 else s.currentPage + 1
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getLeads(
                search = s.search.ifBlank { null },
                status = s.selectedStatus,
                page   = page,
            )) {
                is WResult.Success -> {
                    val page2: LeadsPage = r.data
                    _state.update { it.copy(
                        isLoading   = false,
                        leads       = if (reset) page2.leads else it.leads + page2.leads,
                        totalPages  = page2.pages,
                        currentPage = page2.currentPage,
                    ) }
                }
                is WResult.Error -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load leads"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}
