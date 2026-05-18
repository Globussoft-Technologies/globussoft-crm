package com.globussoft.wellness.feature.crm.presentation.projects

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
class ProjectsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ProjectsUiState())
    val state: StateFlow<ProjectsUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()
    fun showCreate() = _state.update { it.copy(showCreateForm = true, formError = null) }
    fun dismissCreate() = _state.update { it.copy(showCreateForm = false, formError = null) }

    fun setStatus(status: String?) {
        _state.update { it.copy(selectedStatus = status) }
        load()
    }

    fun createProject(name: String, description: String, deadline: String) {
        viewModelScope.launch {
            _state.update { it.copy(isCreating = true, formError = null) }
            val result = repo.createProject(
                name        = name,
                description = description.ifBlank { null },
                deadline    = deadline.ifBlank { null },
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
            val result = repo.getProjects(status = _state.value.selectedStatus)
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isLoading = false, projects = result.data)
                    is WResult.Error   -> current.copy(isLoading = false, error = result.message ?: result.exception.message ?: "Failed to load projects")
                    WResult.Loading    -> current.copy(isLoading = true)
                }
            }
        }
    }
}
