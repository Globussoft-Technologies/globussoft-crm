package com.globussoft.wellness.feature.telecaller.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.network.model.request.DispositionRequest
import com.globussoft.wellness.feature.telecaller.domain.repository.TelecallerRepository
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
 * ViewModel for the Telecaller Queue screen.
 *
 * ### Initialization
 * On first creation, the lead queue is fetched from the backend.  The first
 * lead in the returned list becomes [TelecallerUiState.currentLead].
 *
 * ### Disposition flow
 * 1. User taps a [DispositionType] button → [SelectDisposition] event opens the
 *    bottom sheet pre-configured for that type.
 * 2. For non-destructive types: user fills the form and taps Submit →
 *    [SubmitDisposition] event calls the API directly.
 * 3. For destructive types (WRONG_NUMBER, JUNK): user taps Submit in the sheet →
 *    [ShowConfirmDialog] opens the confirm dialog → [ConfirmDisposition] calls
 *    the API after the user confirms.
 *
 * ### After disposition
 * On a successful disposition, the disposed lead is removed from the queue and
 * the next lead (queue[1] pre-disposal) becomes the current lead.  If the queue
 * is now empty, [currentLead] is set to null.
 */
@HiltViewModel
class TelecallerViewModel @Inject constructor(
    private val repository: TelecallerRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(TelecallerUiState())
    val state: StateFlow<TelecallerUiState> = _state.asStateFlow()

    private val _effects = Channel<TelecallerEffect>(Channel.BUFFERED)
    val effects: Flow<TelecallerEffect> = _effects.receiveAsFlow()

    init {
        loadQueue()
    }

    // -------------------------------------------------------------------------
    // Public event handler
    // -------------------------------------------------------------------------

    fun onEvent(event: TelecallerEvent) {
        when (event) {
            is TelecallerEvent.SelectDisposition -> onSelectDisposition(event.type)
            is TelecallerEvent.FormFieldChanged  -> onFormFieldChanged(event.field, event.value)
            TelecallerEvent.ShowConfirmDialog    -> _state.update { it.copy(showConfirmDialog = true) }
            TelecallerEvent.ConfirmDisposition   -> submitDisposition()
            TelecallerEvent.DismissSheet         -> _state.update {
                it.copy(showDispositionSheet = false, selectedDisposition = null, dispositionForm = DispositionFormState())
            }
            TelecallerEvent.DismissConfirm       -> _state.update { it.copy(showConfirmDialog = false) }
            TelecallerEvent.RefreshQueue         -> loadQueue()
            is TelecallerEvent.LoadLead          -> loadLead(event.leadId)
            TelecallerEvent.SubmitDisposition    -> {
                val disposition = _state.value.selectedDisposition ?: return
                if (disposition.isDestructive) {
                    _state.update { it.copy(showConfirmDialog = true) }
                } else {
                    submitDisposition()
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Private handlers
    // -------------------------------------------------------------------------

    private fun loadQueue() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repository.getQueue()) {
                is WResult.Success -> {
                    val queue = result.data
                    _state.update { it.copy(
                        isLoading   = false,
                        queue       = queue,
                        currentLead = queue.firstOrNull(),
                        error       = null,
                    ) }
                }
                is WResult.Error -> {
                    val message = result.message ?: result.exception.message ?: "Failed to load queue"
                    _state.update { it.copy(isLoading = false, error = message) }
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun loadLead(leadId: String) {
        val lead = _state.value.queue.firstOrNull { it.id == leadId } ?: return
        _state.update { it.copy(currentLead = lead) }
    }

    private fun onSelectDisposition(type: DispositionType) {
        _state.update { it.copy(
            selectedDisposition  = type,
            showDispositionSheet = true,
            dispositionForm      = DispositionFormState(),
            submitError          = null,
        ) }
    }

    private fun onFormFieldChanged(field: String, value: String) {
        _state.update { current ->
            current.copy(
                dispositionForm = when (field) {
                    "notes"              -> current.dispositionForm.copy(notes = value)
                    "callbackDateTime"   -> current.dispositionForm.copy(callbackDateTime = value)
                    "appointmentService" -> current.dispositionForm.copy(appointmentService = value)
                    "appointmentTime"    -> current.dispositionForm.copy(appointmentTime = value)
                    else                 -> current.dispositionForm
                },
            )
        }
    }

    private fun submitDisposition() {
        val current = _state.value
        val lead        = current.currentLead ?: return
        val disposition = current.selectedDisposition ?: return
        val form        = current.dispositionForm

        val request = DispositionRequest(
            type               = disposition.apiType,
            notes              = form.notes.takeIf { it.isNotBlank() },
            callbackAt         = form.callbackDateTime.takeIf { disposition == DispositionType.CALLBACK && it.isNotBlank() },
            appointmentDetails = buildAppointmentDetails(form).takeIf { disposition == DispositionType.BOOKED },
        )

        viewModelScope.launch {
            _state.update { it.copy(isSubmitting = true, showConfirmDialog = false, submitError = null) }

            when (val result = repository.disposeLead(leadId = lead.id, request = request)) {
                is WResult.Success -> {
                    // Remove the disposed lead and advance to the next.
                    val updatedQueue = current.queue.filter { it.id != lead.id }
                    _state.update { it.copy(
                        isSubmitting         = false,
                        showDispositionSheet = false,
                        selectedDisposition  = null,
                        dispositionForm      = DispositionFormState(),
                        queue                = updatedQueue,
                        currentLead          = updatedQueue.firstOrNull(),
                    ) }
                    _effects.send(TelecallerEffect.ShowSnackbar("Disposition saved for ${lead.contactName}"))
                }
                is WResult.Error -> {
                    val message = result.message ?: result.exception.message ?: "Failed to submit disposition"
                    _state.update { it.copy(isSubmitting = false, submitError = message) }
                    _effects.send(TelecallerEffect.ShowSnackbar(message))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun buildAppointmentDetails(form: DispositionFormState): String {
        val parts = mutableListOf<String>()
        if (form.appointmentService.isNotBlank()) parts.add("Service: ${form.appointmentService}")
        if (form.appointmentTime.isNotBlank())    parts.add("Time: ${form.appointmentTime}")
        return parts.joinToString(", ")
    }
}
