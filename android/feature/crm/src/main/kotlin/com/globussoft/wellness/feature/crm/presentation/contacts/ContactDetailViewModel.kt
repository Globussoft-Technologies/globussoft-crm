package com.globussoft.wellness.feature.crm.presentation.contacts

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ContactDetailViewModel @Inject constructor(
    private val repo: CrmRepository,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val contactId: String = savedStateHandle.get<String>("contactId") ?: ""

    private val _state = MutableStateFlow(ContactDetailUiState())
    val state: StateFlow<ContactDetailUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    fun showEdit() = _state.update { it.copy(showEditForm = true, formError = null) }
    fun dismissEdit() = _state.update { it.copy(showEditForm = false, formError = null) }

    fun saveContact(name: String, email: String, phone: String, company: String) {
        viewModelScope.launch {
            _state.update { it.copy(isUpdating = true, formError = null) }
            val result = repo.updateContact(
                contactId,
                name,
                email.ifBlank { null },
                phone.ifBlank { null },
                company.ifBlank { null },
                null,
            )
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(
                        isUpdating = false, showEditForm = false,
                        contact = result.data,
                    )
                    is WResult.Error   -> current.copy(
                        isUpdating = false,
                        formError = result.message ?: result.exception.message,
                    )
                    WResult.Loading    -> current
                }
            }
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            launch {
                when (val r = repo.getContact(contactId)) {
                    is WResult.Success -> _state.update { it.copy(isLoading = false, contact = r.data) }
                    is WResult.Error   -> _state.update { it.copy(isLoading = false, error = r.message ?: r.exception.message) }
                    WResult.Loading    -> Unit
                }
            }
            launch {
                when (val r = repo.getDeals(search = null, skip = 0)) {
                    is WResult.Success -> _state.update { s ->
                        s.copy(
                            deals = r.data.filter { d ->
                                d.contactName?.contains(
                                    _state.value.contact?.name ?: "",
                                    ignoreCase = true
                                ) == true
                            }
                        )
                    }
                    else -> Unit
                }
            }
            launch {
                when (val r = repo.getTasks()) {
                    is WResult.Success -> _state.update { it.copy(tasks = r.data.take(10)) }
                    else -> Unit
                }
            }
        }
    }
}
