package com.globussoft.wellness.feature.crm.presentation.tasks

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
class TasksViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(TasksUiState())
    val state: StateFlow<TasksUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun setStatus(status: String?) {
        _state.update { it.copy(selectedStatus = status) }
        load()
    }

    fun completeTask(id: String) {
        viewModelScope.launch {
            repo.completeTask(id)
            load()
        }
    }

    fun showAdd() = _state.update { it.copy(showAddForm = true) }
    fun dismissForm() = _state.update { it.copy(showAddForm = false, formError = null) }

    fun createTask(title: String, description: String, dueDate: String, priority: String?) {
        viewModelScope.launch {
            _state.update { it.copy(isCreating = true, formError = null) }
            val result = repo.createTask(
                title       = title,
                description = description.ifBlank { null },
                dueDate     = dueDate.ifBlank { null },
                assigneeId  = null,
                priority    = priority.takeUnless { it.isNullOrBlank() },
            )
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isCreating = false, showAddForm = false)
                    is WResult.Error   -> current.copy(isCreating = false, formError = result.message ?: result.exception.message)
                    WResult.Loading    -> current
                }
            }
            if (result is WResult.Success) load()
        }
    }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val result = repo.getTasks(status = _state.value.selectedStatus)
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(
                        isLoading = false,
                        tasks     = result.data,
                        error     = null,
                    )
                    is WResult.Error   -> current.copy(
                        isLoading = false,
                        error     = result.message ?: result.exception.message ?: "Failed to load tasks",
                    )
                    WResult.Loading    -> current.copy(isLoading = true)
                }
            }
        }
    }
}
