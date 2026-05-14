package com.globussoft.wellness.feature.patients.presentation.detail

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.model.request.CreateVisitRequest
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.feature.patients.domain.repository.PatientsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

private const val KEY_SELECTED_TAB = "selected_tab"
private const val KEY_PATIENT_ID   = "patientId"

/**
 * ViewModel for the Patient detail screen.
 *
 * On initialisation, loads the patient record, the patient's visit history,
 * the active service catalog, and the doctor list in parallel to minimise
 * perceived latency. The parallel fan-out uses [kotlinx.coroutines.async]
 * with structured concurrency so all four results arrive before the state
 * transitions out of the loading phase.
 *
 * [selectedTabIndex] is saved to and restored from [SavedStateHandle] so the
 * active tab survives screen rotation, process death, and multi-window resize.
 */
@HiltViewModel
class PatientDetailViewModel @Inject constructor(
    private val repository: PatientsRepository,
    private val api: WellnessApi,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    // Populated either from SavedStateHandle (nav route) or via initialize() (inline two-pane).
    private var patientId: String = savedStateHandle[KEY_PATIENT_ID] ?: ""

    private val _state = MutableStateFlow(
        PatientDetailUiState(
            selectedTabIndex = savedStateHandle[KEY_SELECTED_TAB] ?: 0,
        )
    )
    val state: StateFlow<PatientDetailUiState> = _state.asStateFlow()

    private val _effects = Channel<PatientDetailEffect>(Channel.BUFFERED)
    val effects: Flow<PatientDetailEffect> = _effects.receiveAsFlow()

    // Back-ref for saving tab index on change.
    private val savedStateHandle = savedStateHandle

    init {
        if (patientId.isNotEmpty()) loadAll()
    }

    /**
     * Called by the screen when the ViewModel is created inline (two-pane layout)
     * rather than via navigation, so SavedStateHandle has no patientId.
     * Safe to call multiple times — only acts on the first non-empty id.
     */
    fun initialize(id: String) {
        if (patientId.isEmpty() && id.isNotEmpty()) {
            patientId = id
            loadAll()
        }
    }

    // ─── Public event dispatcher ──────────────────────────────────────────────

    fun onEvent(event: PatientDetailEvent) {
        when (event) {
            is PatientDetailEvent.TabSelected    -> onTabSelected(event.index)
            is PatientDetailEvent.Refresh        -> loadAll()
            is PatientDetailEvent.LogVisit       -> onLogVisit(event)
            is PatientDetailEvent.RedeemGiftCard -> onRedeemGiftCard(event)
        }
    }

    // ─── Private handlers ─────────────────────────────────────────────────────

    private fun loadAll() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }

            val patientDeferred  = async { repository.getPatient(patientId) }
            val visitsDeferred   = async { repository.getPatientVisits(patientId) }
            val servicesDeferred = async { repository.getServices() }
            val doctorsDeferred  = async { repository.getDoctors() }

            val patientResult  = patientDeferred.await()
            val visitsResult   = visitsDeferred.await()
            val servicesResult = servicesDeferred.await()
            val doctorsResult  = doctorsDeferred.await()

            when (patientResult) {
                is WResult.Success -> {
                    _state.update { current ->
                        current.copy(
                            isLoading = false,
                            patient   = patientResult.data,
                            visits    = visitsResult.getOrEmpty(),
                            services  = servicesResult.getOrEmpty(),
                            doctors   = doctorsResult.getOrEmpty(),
                            error     = null,
                        )
                    }
                }
                is WResult.Error -> {
                    val message = patientResult.message
                        ?: patientResult.exception.message
                        ?: "Failed to load patient"
                    _state.update { it.copy(isLoading = false, error = message) }
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onTabSelected(index: Int) {
        savedStateHandle[KEY_SELECTED_TAB] = index
        _state.update { it.copy(selectedTabIndex = index) }
    }

    private fun onRedeemGiftCard(event: PatientDetailEvent.RedeemGiftCard) {
        val code = event.code.trim()
        if (code.isBlank()) {
            viewModelScope.launch {
                _effects.send(PatientDetailEffect.ShowSnackbar("Please enter a gift card code"))
            }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(isRedeeming = true) }
            val result = safeApiCall {
                api.redeemGiftCard(mapOf("code" to code, "patientId" to patientId))
            }
            when (result) {
                is WResult.Success -> {
                    _state.update { it.copy(isRedeeming = false) }
                    _effects.send(PatientDetailEffect.ShowSnackbar("Gift card redeemed successfully"))
                }
                is WResult.Error -> {
                    val message = result.message ?: result.exception.message ?: "Failed to redeem gift card"
                    _state.update { it.copy(isRedeeming = false) }
                    _effects.send(PatientDetailEffect.ShowSnackbar(message))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onLogVisit(event: PatientDetailEvent.LogVisit) {
        viewModelScope.launch {
            _state.update { it.copy(isLoggingVisit = true, logVisitError = null) }

            val visitDate = "${event.date}T10:00:00.000Z"

            val result = safeApiCall {
                api.createVisit(
                    CreateVisitRequest(
                        patientId         = patientId,
                        doctorId          = event.doctorId.ifBlank { null },
                        serviceId         = event.serviceId.ifBlank { null },
                        locationId        = null,
                        visitDate         = visitDate,
                        bookingType       = event.bookingType,
                        notes             = event.notes.ifBlank { null },
                        travelTimeMinutes = null,
                    )
                )
            }

            when (result) {
                is WResult.Success -> {
                    val newVisit = result.data.toDomain()
                    _state.update { current ->
                        current.copy(
                            isLoggingVisit = false,
                            logVisitError  = null,
                            visits         = listOf(newVisit) + current.visits,
                            patient        = current.patient?.let { p ->
                                p.copy(visitsCount = p.visitsCount + 1)
                            },
                        )
                    }
                    _effects.send(PatientDetailEffect.ShowSnackbar("Visit logged successfully"))
                }
                is WResult.Error -> {
                    val message = result.message ?: result.exception.message ?: "Failed to log visit"
                    _state.update { it.copy(isLoggingVisit = false, logVisitError = message) }
                    _effects.send(PatientDetailEffect.ShowSnackbar(message))
                }
                WResult.Loading -> Unit
            }
        }
    }
}

// ─── Helper extensions ────────────────────────────────────────────────────────

private fun <T> WResult<List<T>>.getOrEmpty(): List<T> =
    if (this is WResult.Success) data else emptyList()
