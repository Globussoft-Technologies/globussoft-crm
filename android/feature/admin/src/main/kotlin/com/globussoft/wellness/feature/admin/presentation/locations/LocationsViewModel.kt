package com.globussoft.wellness.feature.admin.presentation.locations

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
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

// ─── UiState ──────────────────────────────────────────────────────────────────

/**
 * Immutable UI state for the Locations CRUD screen.
 *
 * [editingLocation] is non-null when the bottom sheet is open for editing an
 * existing location; null when the sheet is being used to create a new one.
 * [showSheet] is the gate that controls sheet visibility.
 */
data class LocationsUiState(
    val isLoading: Boolean = false,
    val locations: List<Location> = emptyList(),
    val error: String? = null,
    val showSheet: Boolean = false,
    val editingLocation: Location? = null,
    val form: LocationFormState = LocationFormState(),
    val isSaving: Boolean = false,
    val saveError: String? = null,
    val showDeleteConfirm: Boolean = false,
    val deletingId: String? = null,
)

data class LocationFormState(
    val name: String = "",
    val addressLine: String = "",
    val city: String = "",
    val state: String = "",
    val pincode: String = "",
    val phone: String = "",
    val email: String = "",
    val pincodeError: String? = null,
)

sealed class LocationsEvent {
    data object OpenNewSheet : LocationsEvent()
    data class OpenEditSheet(val location: Location) : LocationsEvent()
    data class FieldChanged(val field: String, val value: String) : LocationsEvent()
    data object Save : LocationsEvent()
    data object DismissSheet : LocationsEvent()
    data class RequestDelete(val id: String) : LocationsEvent()
    data object ConfirmDelete : LocationsEvent()
    data object DismissDelete : LocationsEvent()
    data object Refresh : LocationsEvent()
}

sealed class LocationsEffect {
    data class ShowSnackbar(val message: String) : LocationsEffect()
}

// ─── ViewModel ────────────────────────────────────────────────────────────────

/**
 * ViewModel for the Locations CRUD screen.
 *
 * Manages the location list and the create/edit bottom sheet.  Pincode is
 * validated as a 6-digit numeric string before submission.
 */
@HiltViewModel
class LocationsViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(LocationsUiState())
    val state: StateFlow<LocationsUiState> = _state.asStateFlow()

    private val _effects = Channel<LocationsEffect>(Channel.BUFFERED)
    val effects: Flow<LocationsEffect> = _effects.receiveAsFlow()

    init { load() }

    fun onEvent(event: LocationsEvent) {
        when (event) {
            LocationsEvent.OpenNewSheet     -> openNewSheet()
            is LocationsEvent.OpenEditSheet -> openEditSheet(event.location)
            is LocationsEvent.FieldChanged  -> onFieldChanged(event.field, event.value)
            LocationsEvent.Save             -> save()
            LocationsEvent.DismissSheet     -> _state.update { it.copy(showSheet = false, editingLocation = null, form = LocationFormState(), saveError = null) }
            is LocationsEvent.RequestDelete -> _state.update { it.copy(showDeleteConfirm = true, deletingId = event.id) }
            LocationsEvent.ConfirmDelete    -> delete()
            LocationsEvent.DismissDelete    -> _state.update { it.copy(showDeleteConfirm = false, deletingId = null) }
            LocationsEvent.Refresh          -> load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getLocations()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, locations = r.data) }
                is WResult.Error   -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load locations"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading    -> Unit
            }
        }
    }

    private fun openNewSheet() {
        _state.update { it.copy(showSheet = true, editingLocation = null, form = LocationFormState(), saveError = null) }
    }

    private fun openEditSheet(location: Location) {
        _state.update { it.copy(
            showSheet       = true,
            editingLocation = location,
            saveError       = null,
            form = LocationFormState(
                name        = location.name,
                addressLine = location.addressLine ?: "",
                city        = location.city ?: "",
                state       = location.state ?: "",
                pincode     = location.pincode ?: "",
                phone       = location.phone ?: "",
                email       = location.email ?: "",
            ),
        ) }
    }

    private fun onFieldChanged(field: String, value: String) {
        _state.update { s ->
            s.copy(
                form = when (field) {
                    "name"        -> s.form.copy(name = value)
                    "addressLine" -> s.form.copy(addressLine = value)
                    "city"        -> s.form.copy(city = value)
                    "state"       -> s.form.copy(state = value)
                    "pincode"     -> s.form.copy(pincode = value, pincodeError = null)
                    "phone"       -> s.form.copy(phone = value)
                    "email"       -> s.form.copy(email = value)
                    else          -> s.form
                },
            )
        }
    }

    private fun save() {
        val form = _state.value.form
        // Validate pincode.
        if (form.pincode.isNotBlank() && !form.pincode.matches(Regex("\\d{6}"))) {
            _state.update { it.copy(form = form.copy(pincodeError = "Must be a 6-digit PIN code")) }
            return
        }
        if (form.name.isBlank()) {
            _state.update { it.copy(saveError = "Name is required") }
            return
        }

        val params = buildMap<String, Any> {
            put("name", form.name.trim())
            put("addressLine", form.addressLine.trim())
            put("city", form.city.trim())
            put("state", form.state.trim())
            put("pincode", form.pincode.trim())
            if (form.phone.isNotBlank()) put("phone", form.phone.trim())
            if (form.email.isNotBlank()) put("email", form.email.trim())
        }

        viewModelScope.launch {
            _state.update { it.copy(isSaving = true, saveError = null) }
            val editingId = _state.value.editingLocation?.id
            val result = if (editingId != null) {
                repository.updateLocation(editingId, params)
            } else {
                repository.createLocation(params)
            }
            when (result) {
                is WResult.Success -> {
                    _state.update { it.copy(isSaving = false, showSheet = false, editingLocation = null, form = LocationFormState()) }
                    _effects.send(LocationsEffect.ShowSnackbar(
                        if (editingId != null) "Location updated" else "Location created",
                    ))
                    load()
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Save failed"
                    _state.update { it.copy(isSaving = false, saveError = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun delete() {
        val id = _state.value.deletingId ?: return
        viewModelScope.launch {
            _state.update { it.copy(showDeleteConfirm = false, deletingId = null) }
            when (val r = repository.deleteLocation(id)) {
                is WResult.Success -> {
                    _effects.send(LocationsEffect.ShowSnackbar("Location deleted"))
                    load()
                }
                is WResult.Error -> {
                    val msg = r.message ?: r.exception.message ?: "Delete failed"
                    _effects.send(LocationsEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }
}
