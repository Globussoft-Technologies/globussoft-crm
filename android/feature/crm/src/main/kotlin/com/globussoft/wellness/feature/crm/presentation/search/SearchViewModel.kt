package com.globussoft.wellness.feature.crm.presentation.search

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class SearchViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(SearchUiState())
    val state: StateFlow<SearchUiState> = _state.asStateFlow()

    private var debounceJob: Job? = null

    fun onQueryChange(q: String) {
        _state.update { it.copy(query = q) }
        debounceJob?.cancel()
        if (q.length < 2) {
            _state.update { it.copy(contacts = emptyList(), deals = emptyList(), tickets = emptyList(), error = null) }
            return
        }
        debounceJob = viewModelScope.launch {
            delay(350)
            search(q)
        }
    }

    private suspend fun search(q: String) {
        _state.update { it.copy(isSearching = true, error = null) }
        val result = repo.globalSearch(q)
        _state.update { current ->
            when (result) {
                is WResult.Success -> {
                    val data = result.data
                    @Suppress("UNCHECKED_CAST")
                    current.copy(
                        isSearching = false,
                        contacts    = (data["contacts"] as? List<*>)
                            ?.mapNotNull { it as? Map<String, Any> } ?: emptyList(),
                        deals       = (data["deals"] as? List<*>)
                            ?.mapNotNull { it as? Map<String, Any> } ?: emptyList(),
                        tickets     = (data["tickets"] as? List<*>)
                            ?.mapNotNull { it as? Map<String, Any> } ?: emptyList(),
                    )
                }
                is WResult.Error -> current.copy(isSearching = false, error = result.message)
                WResult.Loading  -> current.copy(isSearching = true)
            }
        }
    }
}
