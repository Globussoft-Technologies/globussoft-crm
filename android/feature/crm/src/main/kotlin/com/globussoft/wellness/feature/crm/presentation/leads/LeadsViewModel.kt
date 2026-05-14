package com.globussoft.wellness.feature.crm.presentation.leads

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Contact
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class LeadsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(LeadsUiState())
    val state: StateFlow<LeadsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun setSearch(q: String) {
        _state.update { it.copy(search = q) }
        load()
    }

    fun setSource(source: String?) {
        _state.update { it.copy(selectedSource = source) }
        load()
    }

    fun refresh() = load()

    fun showAdd() = _state.update { it.copy(showAddForm = true, editingLead = null) }
    fun showEdit(lead: Contact) = _state.update { it.copy(showAddForm = true, editingLead = lead) }
    fun dismissForm() = _state.update { it.copy(showAddForm = false, editingLead = null, formError = null) }

    fun saveLead(name: String, email: String, phone: String, company: String, source: String) {
        viewModelScope.launch {
            _state.update { it.copy(isCreating = true, formError = null) }
            val editing = _state.value.editingLead
            val result = if (editing != null) {
                repo.updateContact(editing.id, name, email.ifBlank { null }, phone.ifBlank { null }, company.ifBlank { null }, source.ifBlank { null })
            } else {
                repo.createContact(name, email.ifBlank { null }, phone.ifBlank { null }, company.ifBlank { null }, source.ifBlank { null }, "Lead")
            }
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isCreating = false, showAddForm = false, editingLead = null)
                    is WResult.Error   -> current.copy(isCreating = false, formError = result.message ?: result.exception.message)
                    WResult.Loading    -> current
                }
            }
            if (result is WResult.Success) load()
        }
    }

    fun convertToContact(id: String) {
        viewModelScope.launch {
            _state.update { it.copy(convertingId = id) }
            val lead = _state.value.leads.find { it.id == id }
            repo.createContact(
                name    = lead?.name ?: "",
                email   = lead?.email,
                phone   = lead?.phone,
                company = lead?.company,
                source  = lead?.source,
                status  = "Contact",
            )
            _state.update { it.copy(convertingId = null) }
            load()
        }
    }

    fun confirmDelete(id: String) = _state.update { it.copy(deleteConfirmId = id) }
    fun cancelDelete() = _state.update { it.copy(deleteConfirmId = null) }

    fun deleteLead(id: String) {
        viewModelScope.launch {
            _state.update { it.copy(deleteConfirmId = null) }
            repo.deleteContact(id)
            load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }

            val result = repo.getContacts(
                status = "Lead",
                search = _state.value.search.ifBlank { null },
            )

            _state.update { current ->
                when (result) {
                    is WResult.Success -> {
                        val filtered = current.selectedSource?.let { src ->
                            result.data.filter { it.source?.equals(src, ignoreCase = true) == true }
                        } ?: result.data
                        current.copy(
                            isLoading = false,
                            leads     = filtered,
                        )
                    }
                    is WResult.Error   -> current.copy(
                        isLoading = false,
                        error     = result.message ?: result.exception.message,
                    )
                    WResult.Loading    -> current.copy(isLoading = true)
                }
            }
        }
    }
}
