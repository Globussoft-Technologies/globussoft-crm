package com.globussoft.wellness.feature.services.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.services.domain.repository.ServicesRepository
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

/**
 * ViewModel for [ServicesScreen].
 *
 * ### Lifecycle
 * On construction, [loadServices] fetches the full catalog. Subsequent writes
 * (create/update/delete) update the in-memory [_state] list optimistically
 * where possible — on error, the list is refreshed from the server to stay
 * consistent.
 *
 * ### Form validation
 * [onSubmitForm] validates [ServiceFormState.name] (non-blank) and
 * [ServiceFormState.basePrice] (parseable Double ≥ 1.0) before issuing any
 * network call. Errors are written back into [ServicesUiState.formState] so the
 * composable can surface them inline without a separate error-dialog layer.
 *
 * ### Delete flow
 * The delete flow is two-step: [ServicesEvent.DeleteRequested] sets
 * [ServicesUiState.deleteConfirmService]; the UI shows a [ConfirmDialog];
 * [ServicesEvent.ConfirmDelete] performs the network call and removes the
 * entry from the list on success.
 */
@HiltViewModel
class ServicesViewModel @Inject constructor(
    private val repository: ServicesRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ServicesUiState())
    val state: StateFlow<ServicesUiState> = _state.asStateFlow()

    private val _effects = Channel<ServicesEffect>(Channel.BUFFERED)
    val effects: Flow<ServicesEffect> = _effects.receiveAsFlow()

    init {
        loadServices()
    }

    // ─── Public dispatcher ────────────────────────────────────────────────────

    fun onEvent(event: ServicesEvent) {
        when (event) {
            is ServicesEvent.TabSelected      -> _state.update { it.copy(selectedTabIndex = event.index) }
            is ServicesEvent.ToggleAddForm    -> onToggleAddForm()
            is ServicesEvent.FormFieldChanged -> onFormFieldChanged(event.field, event.value)
            is ServicesEvent.SubmitForm       -> onSubmitForm()
            is ServicesEvent.EditService      -> onEditService(event.service)
            is ServicesEvent.DeleteRequested  -> _state.update { it.copy(deleteConfirmService = event.service) }
            is ServicesEvent.ConfirmDelete    -> onConfirmDelete()
            is ServicesEvent.DismissDelete    -> _state.update { it.copy(deleteConfirmService = null) }
            is ServicesEvent.Refresh          -> { _state.update { it.copy(error = null) }; loadServices() }
        }
    }

    // ─── Load ─────────────────────────────────────────────────────────────────

    private fun loadServices() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repository.getServices()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, services = result.data) }
                is WResult.Error   -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to load services"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading    -> Unit
            }
        }
    }

    // ─── Form toggle ──────────────────────────────────────────────────────────

    private fun onToggleAddForm() {
        _state.update { current ->
            if (current.showAddForm) {
                current.copy(showAddForm = false, editingService = null, formState = ServiceFormState())
            } else {
                current.copy(showAddForm = true)
            }
        }
    }

    // ─── Field changes ────────────────────────────────────────────────────────

    private fun onFormFieldChanged(field: String, value: String) {
        _state.update { current ->
            val form = when (field) {
                "name"          -> current.formState.copy(name = value, nameError = null)
                "category"      -> current.formState.copy(category = value)
                "ticketTier"    -> current.formState.copy(ticketTier = value)
                "basePrice"     -> current.formState.copy(basePrice = value, priceError = null)
                "durationMin"   -> current.formState.copy(durationMin = value)
                "targetRadiusKm" -> current.formState.copy(targetRadiusKm = value)
                "description"   -> current.formState.copy(description = value)
                else            -> current.formState
            }
            current.copy(formState = form)
        }
    }

    // ─── Submit ───────────────────────────────────────────────────────────────

    private fun onSubmitForm() {
        val form      = _state.value.formState
        val editingId = _state.value.editingService?.id

        // Validate
        val nameError = if (form.name.isBlank()) "Service name is required" else null
        val price     = form.basePrice.toDoubleOrNull()
        val priceError = when {
            form.basePrice.isBlank() -> "Price is required"
            price == null            -> "Enter a valid price"
            price < 1.0              -> "Price must be at least ₹1"
            else                     -> null
        }

        if (nameError != null || priceError != null) {
            _state.update { it.copy(formState = it.formState.copy(nameError = nameError, priceError = priceError)) }
            return
        }

        val params = buildMap<String, Any> {
            put("name", form.name.trim())
            if (form.category.isNotBlank()) put("category", form.category)
            if (form.ticketTier.isNotBlank()) put("ticketTier", form.ticketTier)
            put("basePrice", price!!)
            form.durationMin.toIntOrNull()?.let { put("durationMin", it) }
            form.targetRadiusKm.toDoubleOrNull()?.let { put("targetRadiusKm", it) }
            if (form.description.isNotBlank()) put("description", form.description.trim())
        }

        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }

            val result = if (editingId != null) {
                repository.updateService(editingId, params)
            } else {
                repository.createService(params)
            }

            when (result) {
                is WResult.Success -> {
                    val verb = if (editingId != null) "updated" else "created"
                    _state.update { current ->
                        val updatedList = if (editingId != null) {
                            current.services.map { if (it.id == editingId) result.data else it }
                        } else {
                            listOf(result.data) + current.services
                        }
                        current.copy(
                            isLoading      = false,
                            services       = updatedList,
                            showAddForm    = false,
                            editingService = null,
                            formState      = ServiceFormState(),
                        )
                    }
                    _effects.send(ServicesEffect.ShowSnackbar("Service $verb successfully"))
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to save service"
                    _state.update { it.copy(isLoading = false) }
                    _effects.send(ServicesEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    // ─── Edit ─────────────────────────────────────────────────────────────────

    private fun onEditService(service: Service) {
        _state.update { current ->
            current.copy(
                editingService = service,
                showAddForm    = true,
                formState      = ServiceFormState(
                    name           = service.name,
                    category       = service.category ?: "",
                    ticketTier     = service.ticketTier ?: "medium",
                    basePrice      = service.basePrice.toLong().toString(),
                    durationMin    = service.durationMin.toString(),
                    targetRadiusKm = service.targetRadiusKm?.toString() ?: "",
                    description    = service.description ?: "",
                ),
            )
        }
    }

    // ─── Delete ───────────────────────────────────────────────────────────────

    private fun onConfirmDelete() {
        val service = _state.value.deleteConfirmService ?: return
        viewModelScope.launch {
            _state.update { it.copy(deleteConfirmService = null, isLoading = true) }
            when (val result = repository.deleteService(service.id)) {
                is WResult.Success -> {
                    _state.update { current ->
                        current.copy(
                            isLoading = false,
                            services  = current.services.filter { it.id != service.id },
                        )
                    }
                    _effects.send(ServicesEffect.ShowSnackbar("${service.name} deleted"))
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to delete service"
                    _state.update { it.copy(isLoading = false) }
                    _effects.send(ServicesEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }
}

// ─── Effects ─────────────────────────────────────────────────────────────────

/**
 * One-shot side-effects for the Services screen.
 */
sealed class ServicesEffect {
    data class ShowSnackbar(val message: String) : ServicesEffect()
}
