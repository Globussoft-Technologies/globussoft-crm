package com.globussoft.wellness.feature.crm.presentation.clients

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
class ClientsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ClientsUiState())
    val state: StateFlow<ClientsUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    fun setSearch(query: String) {
        _state.update { it.copy(searchQuery = query) }
        load()
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val result = repo.getContacts(
                status = "Client",
                search = _state.value.searchQuery.ifBlank { null },
            )
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isLoading = false, clients = result.data)
                    is WResult.Error   -> current.copy(isLoading = false, error = result.message ?: result.exception.message ?: "Failed to load clients")
                    WResult.Loading    -> current.copy(isLoading = true)
                }
            }
        }
    }
}
