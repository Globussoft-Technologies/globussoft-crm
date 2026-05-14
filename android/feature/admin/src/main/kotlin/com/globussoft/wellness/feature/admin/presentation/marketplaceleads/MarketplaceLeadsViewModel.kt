package com.globussoft.wellness.feature.admin.presentation.marketplaceleads

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.MarketplaceLeadItem
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class MarketplaceLeadsUiState(
    val isLoading: Boolean = false,
    val leads: List<MarketplaceLeadItem> = emptyList(),
    val error: String? = null,
    val providerFilter: String? = null,
    val statusFilter: String? = null,
    val currentPage: Int = 1,
    val totalPages: Int = 1,
    val isLoadingMore: Boolean = false,
)

@HiltViewModel
class MarketplaceLeadsViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(MarketplaceLeadsUiState())
    val state: StateFlow<MarketplaceLeadsUiState> = _state.asStateFlow()

    init { load(page = 1) }

    fun refresh() = load(page = 1)

    fun setProviderFilter(provider: String?) {
        _state.update { it.copy(providerFilter = provider) }
        load(page = 1)
    }

    fun setStatusFilter(status: String?) {
        _state.update { it.copy(statusFilter = status) }
        load(page = 1)
    }

    fun loadNextPage() {
        val s = _state.value
        if (s.isLoadingMore || s.currentPage >= s.totalPages) return
        load(page = s.currentPage + 1, append = true)
    }

    private fun load(page: Int, append: Boolean = false) {
        val s = _state.value
        viewModelScope.launch {
            if (append) {
                _state.update { it.copy(isLoadingMore = true) }
            } else {
                _state.update { it.copy(isLoading = true, error = null) }
            }
            when (val r = repository.getMarketplaceLeads(s.providerFilter, s.statusFilter, page)) {
                is WResult.Success -> _state.update { st ->
                    st.copy(
                        isLoading     = false,
                        isLoadingMore = false,
                        leads         = if (append) st.leads + r.data.leads else r.data.leads,
                        currentPage   = r.data.currentPage,
                        totalPages    = r.data.pages,
                    )
                }
                is WResult.Error -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load marketplace leads"
                    _state.update { it.copy(isLoading = false, isLoadingMore = false, error = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}
