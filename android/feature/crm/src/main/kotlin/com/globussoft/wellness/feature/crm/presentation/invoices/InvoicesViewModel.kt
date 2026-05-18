package com.globussoft.wellness.feature.crm.presentation.invoices

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
class InvoicesViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(InvoicesUiState())
    val state: StateFlow<InvoicesUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun setStatus(status: String?) {
        _state.update { it.copy(selectedStatus = status) }
        load()
    }

    fun sendInvoice(id: String) {
        viewModelScope.launch {
            when (val result = repo.sendInvoice(id)) {
                is WResult.Success -> load()
                is WResult.Error   -> _state.update {
                    it.copy(error = result.message ?: result.exception.message ?: "Failed to send invoice")
                }
                WResult.Loading    -> Unit
            }
        }
    }

    fun markPaid(id: String) {
        viewModelScope.launch {
            when (val result = repo.markInvoicePaid(id)) {
                is WResult.Success -> load()
                is WResult.Error   -> _state.update {
                    it.copy(error = result.message ?: result.exception.message ?: "Failed to mark invoice as paid")
                }
                WResult.Loading    -> Unit
            }
        }
    }

    fun voidInvoice(id: String) {
        viewModelScope.launch {
            when (val result = repo.voidInvoice(id)) {
                is WResult.Success -> load()
                is WResult.Error   -> _state.update {
                    it.copy(error = result.message ?: result.exception.message ?: "Failed to void invoice")
                }
                WResult.Loading    -> Unit
            }
        }
    }

    fun refresh() = load()

    fun showCreate() = _state.update { it.copy(showCreateForm = true, formError = null) }
    fun dismissCreate() = _state.update { it.copy(showCreateForm = false, formError = null) }

    fun createInvoice(dueDate: String, notes: String) {
        viewModelScope.launch {
            _state.update { it.copy(isCreating = true, formError = null) }
            val lineItems = listOf(
                com.globussoft.wellness.core.network.model.request.InvoiceLineItemRequest(
                    description = notes.ifBlank { "Service" },
                    quantity    = 1,
                    unitPrice   = 0.0,
                )
            )
            val result = repo.createInvoice(
                contactId = null,
                dueDate   = dueDate.ifBlank { null },
                notes     = notes.ifBlank { null },
                lineItems = lineItems,
            )
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isCreating = false, showCreateForm = false)
                    is WResult.Error   -> current.copy(isCreating = false, formError = result.message ?: result.exception.message)
                    WResult.Loading    -> current
                }
            }
            if (result is WResult.Success) load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val result = repo.getInvoices(status = _state.value.selectedStatus)
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(
                        isLoading = false,
                        invoices  = result.data,
                        error     = null,
                    )
                    is WResult.Error   -> current.copy(
                        isLoading = false,
                        error     = result.message ?: result.exception.message ?: "Failed to load invoices",
                    )
                    WResult.Loading    -> current.copy(isLoading = true)
                }
            }
        }
    }
}
