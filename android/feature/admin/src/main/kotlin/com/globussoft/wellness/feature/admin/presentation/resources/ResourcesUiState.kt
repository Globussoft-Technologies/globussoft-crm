package com.globussoft.wellness.feature.admin.presentation.resources

data class Resource(
    val id: String,
    val name: String,
    val type: String,
    val capacity: Int?,
    val isActive: Boolean,
)

sealed interface ResourcesEvent {
    data object Refresh : ResourcesEvent
    data object ToggleAddForm : ResourcesEvent
    data class FormFieldChanged(val field: String, val value: String) : ResourcesEvent
    data class DeleteResource(val id: String) : ResourcesEvent
    data object SubmitForm : ResourcesEvent
}

data class ResourcesAddForm(
    val name: String = "",
    val type: String = "room",
    val capacity: String = "",
)

data class ResourcesUiState(
    val resources: List<Resource> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val showAddForm: Boolean = false,
    val addForm: ResourcesAddForm = ResourcesAddForm(),
    val isCreating: Boolean = false,
)
