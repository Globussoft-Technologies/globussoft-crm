package com.globussoft.wellness.feature.admin.presentation.resources

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject
import com.globussoft.wellness.core.common.result.WResult

sealed class ResourcesEffect {
    data class ShowSnackbar(val message: String) : ResourcesEffect()
}

/**
 * ViewModel for the Resources admin screen.
 *
 * Loads the list of treatment rooms and equipment from [WellnessApi.getResources].
 * Add and delete operations are not yet available server-side; attempting either
 * shows an informational snackbar rather than making a network call.
 */
@HiltViewModel
class ResourcesViewModel @Inject constructor(
    private val api: WellnessApi,
) : ViewModel() {

    private val _state = MutableStateFlow(ResourcesUiState())
    val state: StateFlow<ResourcesUiState> = _state.asStateFlow()

    private val _effects = Channel<ResourcesEffect>(Channel.BUFFERED)
    val effects: Flow<ResourcesEffect> = _effects.receiveAsFlow()

    init { load() }

    fun onEvent(event: ResourcesEvent) {
        when (event) {
            ResourcesEvent.Refresh        -> load()
            ResourcesEvent.ToggleAddForm  -> _state.update { it.copy(showAddForm = !it.showAddForm, addForm = ResourcesAddForm()) }
            is ResourcesEvent.FormFieldChanged -> onFieldChanged(event.field, event.value)
            ResourcesEvent.SubmitForm     -> submitForm()
            is ResourcesEvent.DeleteResource -> deleteResource(event.id)
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = safeApiCall { api.getResources(activeOnly = 0) }) {
                is WResult.Success -> {
                    val resources = result.data.mapNotNull { item ->
                        @Suppress("UNCHECKED_CAST")
                        val map = item as? Map<String, Any> ?: return@mapNotNull null
                        val id       = map["id"]?.let { if (it is Number) it.toLong().toString() else it as? String } ?: return@mapNotNull null
                        val name     = map["name"]     as? String ?: return@mapNotNull null
                        val type     = map["type"]     as? String ?: "room"
                        val capacity = (map["capacity"] as? Number)?.toInt()
                        val isActive = map["isActive"] as? Boolean ?: true
                        Resource(id = id, name = name, type = type, capacity = capacity, isActive = isActive)
                    }
                    _state.update { it.copy(isLoading = false, resources = resources) }
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to load resources"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onFieldChanged(field: String, value: String) {
        _state.update { s ->
            s.copy(
                addForm = when (field) {
                    "name"     -> s.addForm.copy(name = value)
                    "type"     -> s.addForm.copy(type = value)
                    "capacity" -> s.addForm.copy(capacity = value)
                    else       -> s.addForm
                },
            )
        }
    }

    private fun submitForm() {
        viewModelScope.launch {
            _effects.send(ResourcesEffect.ShowSnackbar("Not yet available"))
            _state.update { it.copy(showAddForm = false, addForm = ResourcesAddForm()) }
        }
    }

    private fun deleteResource(@Suppress("UNUSED_PARAMETER") id: String) {
        viewModelScope.launch {
            _effects.send(ResourcesEffect.ShowSnackbar("Not yet available"))
        }
    }
}
