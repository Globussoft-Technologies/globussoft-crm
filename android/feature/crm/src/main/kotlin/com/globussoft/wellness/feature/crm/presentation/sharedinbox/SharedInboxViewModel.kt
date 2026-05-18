package com.globussoft.wellness.feature.crm.presentation.sharedinbox

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
class SharedInboxViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(SharedInboxUiState())
    val state: StateFlow<SharedInboxUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    fun setStatus(status: String?) {
        _state.update { it.copy(selectedStatus = status) }
        load()
    }

    fun assignItem(id: String, assigneeId: String) {
        viewModelScope.launch {
            _state.update { it.copy(assigningId = id) }
            repo.assignSharedInboxItem(id, assigneeId)
            _state.update { it.copy(assigningId = null) }
            load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val result = repo.getSharedInbox(status = _state.value.selectedStatus)
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isLoading = false, conversations = result.data)
                    is WResult.Error   -> current.copy(isLoading = false, error = result.message ?: result.exception.message ?: "Failed to load shared inbox")
                    WResult.Loading    -> current.copy(isLoading = true)
                }
            }
        }
    }
}
