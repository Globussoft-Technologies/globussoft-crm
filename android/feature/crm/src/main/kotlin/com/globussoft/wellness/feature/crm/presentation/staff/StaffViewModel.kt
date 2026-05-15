package com.globussoft.wellness.feature.crm.presentation.staff

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
class StaffViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(StaffUiState())
    val state: StateFlow<StaffUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun setSearch(query: String) {
        _state.update { it.copy(search = query) }
    }

    fun refresh() = load()

    fun showCreate() = _state.update { it.copy(showForm = true, editingId = null, formError = null) }
    fun showEdit(member: Map<String, Any>) = _state.update {
        it.copy(showForm = true, editingId = member["id"]?.toString(), formError = null)
    }
    fun dismissForm() = _state.update { it.copy(showForm = false, editingId = null, formError = null) }

    fun saveMember(name: String, email: String, role: String) {
        viewModelScope.launch {
            _state.update { it.copy(isSubmitting = true, formError = null) }
            val editId = _state.value.editingId
            val result = if (editId != null) {
                repo.updateStaff(editId, mapOf("name" to name, "email" to email, "role" to role))
            } else {
                repo.createStaff(name, email, role)
            }
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isSubmitting = false, showForm = false, editingId = null)
                    is WResult.Error   -> current.copy(isSubmitting = false, formError = result.message ?: result.exception.message)
                    WResult.Loading    -> current
                }
            }
            if (result is WResult.Success) load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repo.getStaff()) {
                is WResult.Success -> _state.update {
                    it.copy(isLoading = false, staff = result.data, error = null)
                }
                is WResult.Error   -> _state.update {
                    it.copy(
                        isLoading = false,
                        error = result.message ?: result.exception.message ?: "Failed to load staff",
                    )
                }
                WResult.Loading    -> Unit
            }
        }
    }
}
