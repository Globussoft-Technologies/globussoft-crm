package com.globussoft.wellness.feature.crm.presentation.tasks

import com.globussoft.wellness.core.domain.model.CrmTask

data class TasksUiState(
    val isLoading: Boolean = false,
    val tasks: List<CrmTask> = emptyList(),
    val error: String? = null,
    val selectedStatus: String? = "PENDING",
    val showAddForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)
