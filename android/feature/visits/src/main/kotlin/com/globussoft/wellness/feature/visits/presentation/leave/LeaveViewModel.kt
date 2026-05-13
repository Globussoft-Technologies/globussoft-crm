package com.globussoft.wellness.feature.visits.presentation.leave

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.datastore.AuthDataStore
import com.globussoft.wellness.feature.visits.domain.model.LeaveRequest
import com.globussoft.wellness.feature.visits.domain.repository.VisitsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class LeaveViewModel @Inject constructor(
    private val repository: VisitsRepository,
    private val authDataStore: AuthDataStore,
) : ViewModel() {

    private val _state   = MutableStateFlow(LeaveUiState())
    val state: StateFlow<LeaveUiState> = _state.asStateFlow()

    private val _effects = Channel<LeaveEffect>(Channel.BUFFERED)
    val effects: Flow<LeaveEffect> = _effects.receiveAsFlow()

    init { loadAll() }

    fun onEvent(event: LeaveEvent) {
        when (event) {
            is LeaveEvent.Refresh           -> loadAll()
            is LeaveEvent.ShowApplySheet    -> _state.update { it.copy(showApplySheet = true, applyForm = LeaveFormState()) }
            is LeaveEvent.DismissApplySheet -> _state.update { it.copy(showApplySheet = false) }
            is LeaveEvent.FormFieldChanged  -> onFormFieldChanged(event.field, event.value)
            is LeaveEvent.SubmitLeave       -> onSubmitLeave()
            is LeaveEvent.ApproveRequest    -> onApprove(event.id)
            is LeaveEvent.RejectRequest     -> onReject(event.id)
        }
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    private fun loadAll() {
        viewModelScope.launch {
            val session   = authDataStore.userFlow.first()
            val isManager = session?.isManager ?: false

            _state.update { it.copy(isLoading = true, error = null, isManager = isManager) }

            val myResult  = repository.getLeaveRequests(myOnly = true)
            when (myResult) {
                is WResult.Success -> _state.update { it.copy(myRequests = myResult.data) }
                is WResult.Error   -> {
                    val msg = myResult.message ?: myResult.exception.message ?: "Failed to load leave requests"
                    _state.update { it.copy(error = msg) }
                    _effects.send(LeaveEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }

            if (isManager) {
                when (val allResult = repository.getLeaveRequests(myOnly = false)) {
                    is WResult.Success -> _state.update { it.copy(allRequests = allResult.data) }
                    else               -> Unit
                }
            }

            _state.update { it.copy(isLoading = false) }
        }
    }

    private fun onFormFieldChanged(field: String, value: String) {
        _state.update { current ->
            val form = when (field) {
                "fromDate" -> current.applyForm.copy(fromDate = value, fromDateError = null)
                "toDate"   -> current.applyForm.copy(toDate = value, toDateError = null)
                "type"     -> current.applyForm.copy(type = value)
                "reason"   -> current.applyForm.copy(reason = value, reasonError = null)
                else       -> current.applyForm
            }
            current.copy(applyForm = form)
        }
    }

    private fun onSubmitLeave() {
        val form = _state.value.applyForm
        val fromError   = if (form.fromDate.isBlank()) "From date is required" else null
        val toError     = if (form.toDate.isBlank())   "To date is required"   else null
        val reasonError = if (form.reason.isBlank())   "Reason is required"    else null

        if (fromError != null || toError != null || reasonError != null) {
            _state.update {
                it.copy(applyForm = it.applyForm.copy(
                    fromDateError = fromError,
                    toDateError   = toError,
                    reasonError   = reasonError,
                ))
            }
            return
        }

        val params: Map<String, Any> = mapOf(
            "fromDate" to form.fromDate,
            "toDate"   to form.toDate,
            "type"     to form.type,
            "reason"   to form.reason,
        )

        viewModelScope.launch {
            _state.update { it.copy(isSubmitting = true) }
            when (val result = repository.createLeaveRequest(params)) {
                is WResult.Success -> {
                    _state.update { current ->
                        current.copy(
                            isSubmitting  = false,
                            showApplySheet = false,
                            myRequests    = listOf(result.data) + current.myRequests,
                        )
                    }
                    _effects.send(LeaveEffect.ShowSnackbar("Leave request submitted"))
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to submit leave"
                    _state.update { it.copy(isSubmitting = false) }
                    _effects.send(LeaveEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onApprove(id: String) {
        viewModelScope.launch {
            _state.update { it.copy(processingId = id) }
            when (val result = repository.approveLeaveRequest(id)) {
                is WResult.Success -> updateRequestInLists(result.data)
                is WResult.Error   -> {
                    val msg = result.message ?: result.exception.message ?: "Approval failed"
                    _effects.send(LeaveEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
            _state.update { it.copy(processingId = null) }
        }
    }

    private fun onReject(id: String) {
        viewModelScope.launch {
            _state.update { it.copy(processingId = id) }
            when (val result = repository.rejectLeaveRequest(id)) {
                is WResult.Success -> updateRequestInLists(result.data)
                is WResult.Error   -> {
                    val msg = result.message ?: result.exception.message ?: "Rejection failed"
                    _effects.send(LeaveEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
            _state.update { it.copy(processingId = null) }
        }
    }

    private fun updateRequestInLists(updated: LeaveRequest) {
        _state.update { current ->
            current.copy(
                myRequests  = current.myRequests.map  { if (it.id == updated.id) updated else it },
                allRequests = current.allRequests.map { if (it.id == updated.id) updated else it },
            )
        }
    }
}
