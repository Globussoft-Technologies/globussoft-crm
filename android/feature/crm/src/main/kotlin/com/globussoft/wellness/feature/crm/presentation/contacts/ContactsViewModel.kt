package com.globussoft.wellness.feature.crm.presentation.contacts

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
class ContactsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ContactsUiState())
    val state: StateFlow<ContactsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun setStatus(status: String?) {
        _state.update { it.copy(selectedStatus = status) }
        load()
    }

    fun setSearch(q: String) {
        _state.update { it.copy(search = q) }
        load()
    }

    fun refresh() = load()

    fun showAdd() = _state.update { it.copy(showAddForm = true, editingContact = null) }

    fun showEdit(contact: Contact) = _state.update { it.copy(showAddForm = true, editingContact = contact) }

    fun dismissForm() = _state.update { it.copy(showAddForm = false, editingContact = null, formError = null) }

    fun saveContact(name: String, email: String, phone: String, company: String, status: String) {
        viewModelScope.launch {
            _state.update { it.copy(isCreating = true, formError = null) }
            val editing = _state.value.editingContact
            val result = if (editing != null) {
                repo.updateContact(editing.id, name, email.ifBlank { null }, phone.ifBlank { null }, company.ifBlank { null }, null)
            } else {
                repo.createContact(name, email.ifBlank { null }, phone.ifBlank { null }, company.ifBlank { null }, null, status.ifBlank { null })
            }
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isCreating = false, showAddForm = false, editingContact = null)
                    is WResult.Error   -> current.copy(isCreating = false, formError = result.message ?: result.exception.message)
                    WResult.Loading    -> current
                }
            }
            if (result is WResult.Success) load()
        }
    }

    fun confirmDelete(id: String) = _state.update { it.copy(deleteConfirmId = id) }

    fun cancelDelete() = _state.update { it.copy(deleteConfirmId = null) }

    fun deleteContact(id: String) {
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
                status = _state.value.selectedStatus,
                search = _state.value.search.ifBlank { null },
            )

            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(
                        isLoading = false,
                        contacts  = result.data,
                    )
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
