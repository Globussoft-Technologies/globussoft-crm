package com.globussoft.wellness.feature.admin.presentation.knowledgebase

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class KnowledgeBaseUiState(
    val isLoading: Boolean = false,
    val articles: List<Unit> = emptyList(),
    val error: String? = null,
)

@HiltViewModel
class KnowledgeBaseViewModel @Inject constructor() : ViewModel() {

    private val _state = MutableStateFlow(KnowledgeBaseUiState())
    val state: StateFlow<KnowledgeBaseUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            // No working API for knowledge base — show empty state gracefully
            _state.update { it.copy(isLoading = false, articles = emptyList()) }
        }
    }
}
