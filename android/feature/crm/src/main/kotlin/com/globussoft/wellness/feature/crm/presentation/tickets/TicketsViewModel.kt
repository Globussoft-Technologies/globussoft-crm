package com.globussoft.wellness.feature.crm.presentation.tickets

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Ticket
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class TicketsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(TicketsUiState())
    val state: StateFlow<TicketsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun setStatus(status: String?) {
        _state.update { it.copy(selectedStatus = status) }
        load()
    }

    fun setPriority(priority: String?) {
        _state.update { it.copy(selectedPriority = priority) }
        load()
    }

    fun refresh() = load()

    fun showAdd() = _state.update { it.copy(showAddForm = true, editingTicket = null) }
    fun showEdit(ticket: Ticket) = _state.update { it.copy(showAddForm = true, editingTicket = ticket) }
    fun dismissForm() = _state.update { it.copy(showAddForm = false, editingTicket = null, formError = null) }

    fun saveTicket(subject: String, description: String, priority: String) {
        viewModelScope.launch {
            _state.update { it.copy(isCreating = true, formError = null) }
            val editing = _state.value.editingTicket
            val result = if (editing != null) {
                repo.updateTicket(editing.id, buildMap {
                    put("subject", subject)
                    put("description", description)
                    put("priority", priority)
                })
            } else {
                repo.createTicket(subject, description.ifBlank { null }, priority)
            }
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isCreating = false, showAddForm = false, editingTicket = null)
                    is WResult.Error   -> current.copy(isCreating = false, formError = result.message ?: result.exception.message)
                    WResult.Loading    -> current
                }
            }
            if (result is WResult.Success) load()
        }
    }

    fun confirmDelete(id: String) = _state.update { it.copy(deleteConfirmId = id) }
    fun cancelDelete() = _state.update { it.copy(deleteConfirmId = null) }

    fun deleteTicket(id: String) {
        viewModelScope.launch {
            _state.update { it.copy(deleteConfirmId = null) }
            repo.updateTicket(id, mapOf("status" to "RESOLVED"))
            load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val result = repo.getTickets(
                status   = _state.value.selectedStatus,
                priority = _state.value.selectedPriority,
            )
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(
                        isLoading = false,
                        tickets   = result.data,
                        error     = null,
                    )
                    is WResult.Error   -> current.copy(
                        isLoading = false,
                        error     = result.message ?: result.exception.message ?: "Failed to load tickets",
                    )
                    WResult.Loading    -> current.copy(isLoading = true)
                }
            }
        }
    }
}
