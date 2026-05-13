package com.globussoft.wellness.feature.patients.presentation.list

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Patient
import com.globussoft.wellness.core.domain.model.PatientForm
import com.globussoft.wellness.feature.patients.domain.usecase.CreatePatientUseCase
import com.globussoft.wellness.feature.patients.domain.usecase.GetPatientsParams
import com.globussoft.wellness.feature.patients.domain.usecase.GetPatientsUseCase
import com.globussoft.wellness.feature.patients.domain.usecase.UpdatePatientUseCase
import com.globussoft.wellness.feature.patients.presentation.list.PatientsListUiState.Companion.PAGE_SIZE
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the Patients list screen.
 *
 * ### Search debouncing
 * A separate [MutableStateFlow] [_searchQuery] holds the raw search text.
 * A `debounce(300ms) + distinctUntilChanged + flatMapLatest` pipeline converts
 * each settled query into a fresh [GetPatientsUseCase] call, automatically
 * cancelling any in-flight call when the user types again.
 *
 * ### Pagination
 * [LoadNextPage] increments [PatientsListUiState.currentPage] and calls
 * [getPatientsPage] with the new offset. Results are appended to the existing
 * [PatientsListUiState.patients] list.
 */
@OptIn(FlowPreview::class)
@HiltViewModel
class PatientsListViewModel @Inject constructor(
    private val getPatientsUseCase: GetPatientsUseCase,
    private val createPatientUseCase: CreatePatientUseCase,
    private val updatePatientUseCase: UpdatePatientUseCase,
) : ViewModel() {

    private val _state = MutableStateFlow(PatientsListUiState())
    val state: StateFlow<PatientsListUiState> = _state.asStateFlow()

    private val _effects = Channel<PatientsListEffect>(Channel.BUFFERED)
    val effects: Flow<PatientsListEffect> = _effects.receiveAsFlow()

    // Raw search query — debounced before it triggers an API call.
    private val _searchQuery = MutableStateFlow("")

    init {
        observeSearch()
    }

    // ─── Public event dispatcher ──────────────────────────────────────────────

    fun onEvent(event: PatientsListEvent) {
        when (event) {
            is PatientsListEvent.SearchChanged    -> onSearchChanged(event.query)
            is PatientsListEvent.ToggleAddForm    -> onToggleAddForm()
            is PatientsListEvent.FormFieldChanged -> onFormFieldChanged(event.field, event.value)
            is PatientsListEvent.SubmitForm       -> onSubmitForm()
            is PatientsListEvent.EditPatient      -> onEditPatient(event.patient)
            is PatientsListEvent.SelectPatient    -> onSelectPatient(event.patient)
            is PatientsListEvent.LoadNextPage     -> onLoadNextPage()
            is PatientsListEvent.Refresh          -> onRefresh()
        }
    }

    // ─── Private handlers ─────────────────────────────────────────────────────

    /**
     * Sets up the debounced search pipeline. Each time the [_searchQuery] flow
     * emits a value (after 300 ms of silence), [flatMapLatest] re-subscribes to
     * a new [GetPatientsUseCase] call, automatically cancelling the previous one.
     */
    private fun observeSearch() {
        _searchQuery
            .debounce(300L)
            .distinctUntilChanged()
            .flatMapLatest { query ->
                _state.update { it.copy(isLoading = true, error = null, currentPage = 0, patients = emptyList()) }
                getPatientsUseCase(GetPatientsParams(search = query, skip = 0, limit = PAGE_SIZE))
            }
            .onEach { result -> handlePatientsResult(result, append = false) }
            .launchIn(viewModelScope)
    }

    private fun onSearchChanged(query: String) {
        _state.update { it.copy(searchQuery = query) }
        _searchQuery.value = query
    }

    private fun onToggleAddForm() {
        _state.update { current ->
            if (current.showAddForm) {
                current.copy(showAddForm = false, editingPatient = null, addForm = PatientFormState())
            } else {
                current.copy(showAddForm = true)
            }
        }
    }

    private fun onFormFieldChanged(field: String, value: String) {
        _state.update { current ->
            val form = when (field) {
                "name"       -> current.addForm.copy(name = value, nameError = null)
                "phone"      -> current.addForm.copy(phone = value, phoneError = null)
                "email"      -> current.addForm.copy(email = value, emailError = null)
                "dob"        -> current.addForm.copy(dob = value)
                "gender"     -> current.addForm.copy(gender = value)
                "source"     -> current.addForm.copy(source = value)
                "locationId" -> current.addForm.copy(locationId = value)
                else         -> current.addForm
            }
            current.copy(addForm = form)
        }
    }

    private fun onSubmitForm() {
        val form = _state.value.addForm
        val editingId = _state.value.editingPatient?.id

        // Validate required fields.
        val nameError  = if (form.name.isBlank()) "Name is required" else null
        val phoneError = validateIndianPhone(form.phone)
        val emailError = if (form.email.isNotBlank() && !isValidEmail(form.email)) {
            "Invalid email address"
        } else null

        if (nameError != null || phoneError != null || emailError != null) {
            _state.update { it.copy(addForm = it.addForm.copy(nameError = nameError, phoneError = phoneError, emailError = emailError)) }
            return
        }

        val patientForm = PatientForm(
            name       = form.name.trim(),
            phone      = form.phone.trim(),
            email      = form.email.trim(),
            dob        = form.dob,
            gender     = form.gender,
            source     = form.source,
            locationId = form.locationId,
        )

        viewModelScope.launch {
            _state.update { it.copy(isCreating = true) }

            val result = if (editingId != null) {
                updatePatientUseCase(UpdatePatientUseCase.Params(id = editingId, form = patientForm))
            } else {
                createPatientUseCase(patientForm)
            }

            when (result) {
                is WResult.Success -> {
                    val verb = if (editingId != null) "updated" else "created"
                    _state.update { current ->
                        val updatedList = if (editingId != null) {
                            current.patients.map { if (it.id == editingId) result.data else it }
                        } else {
                            listOf(result.data) + current.patients
                        }
                        current.copy(
                            isCreating     = false,
                            showAddForm    = false,
                            editingPatient = null,
                            addForm        = PatientFormState(),
                            patients       = updatedList,
                        )
                    }
                    _effects.send(PatientsListEffect.ShowSnackbar("Patient $verb successfully"))
                }
                is WResult.Error -> {
                    val message = result.message ?: result.exception.message ?: "Failed to save patient"
                    _state.update { it.copy(isCreating = false) }
                    _effects.send(PatientsListEffect.ShowSnackbar(message))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onEditPatient(patient: Patient) {
        _state.update { current ->
            current.copy(
                editingPatient = patient,
                showAddForm    = true,
                addForm        = PatientFormState(
                    name       = patient.name,
                    phone      = patient.phone,
                    email      = patient.email ?: "",
                    dob        = patient.dob ?: "",
                    gender     = patient.gender ?: "",
                    source     = patient.source ?: "",
                    locationId = patient.locationId ?: "",
                ),
            )
        }
    }

    private fun onSelectPatient(patient: Patient) {
        viewModelScope.launch {
            _effects.send(PatientsListEffect.NavigateToDetail(patient.id))
        }
    }

    private fun onLoadNextPage() {
        val currentState = _state.value
        if (currentState.isLoading || currentState.hasReachedEnd) return

        val nextPage = currentState.currentPage + 1
        _state.update { it.copy(currentPage = nextPage, isLoading = true) }

        viewModelScope.launch {
            getPatientsUseCase(
                GetPatientsParams(
                    search = currentState.searchQuery,
                    skip   = nextPage * PAGE_SIZE,
                    limit  = PAGE_SIZE,
                )
            ).collect { result -> handlePatientsResult(result, append = true) }
        }
    }

    private fun onRefresh() {
        _state.update { it.copy(currentPage = 0, patients = emptyList(), error = null) }
        // Re-trigger by re-emitting the current search query through the pipeline.
        _searchQuery.value = _state.value.searchQuery
    }

    /**
     * Merges a [WResult]<PaginatedPatients> into the UI state.
     *
     * @param append When `true` new patients are appended to the existing list
     *               (pagination); when `false` the list is replaced (initial
     *               load / search / refresh).
     */
    private fun handlePatientsResult(result: WResult<*>, append: Boolean) {
        when (result) {
            is WResult.Success -> {
                @Suppress("UNCHECKED_CAST")
                val paginated = result as? WResult.Success<com.globussoft.wellness.feature.patients.domain.repository.PaginatedPatients>
                    ?: return
                _state.update { current ->
                    val merged = if (append) current.patients + paginated.data.patients
                    else paginated.data.patients
                    current.copy(
                        isLoading  = false,
                        patients   = merged,
                        totalCount = paginated.data.total,
                        error      = null,
                    )
                }
            }
            is WResult.Error -> {
                val message = result.message ?: result.exception.message ?: "Failed to load patients"
                _state.update { it.copy(isLoading = false, error = message) }
            }
            WResult.Loading -> {
                _state.update { it.copy(isLoading = true, error = null) }
            }
        }
    }

    // ─── Validation helpers ───────────────────────────────────────────────────

    /**
     * Validates an Indian mobile number.
     * Accepts 10-digit numbers starting with 6–9, with optional +91 / 0 prefix.
     * Returns an error message string on failure, or null on success.
     */
    private fun validateIndianPhone(phone: String): String? {
        if (phone.isBlank()) return "Phone number is required"
        val digits = phone.trim().replace(Regex("[+\\s-]"), "")
        val normalized = if (digits.startsWith("91") && digits.length == 12) {
            digits.substring(2)
        } else if (digits.startsWith("0") && digits.length == 11) {
            digits.substring(1)
        } else digits
        return if (normalized.length == 10 && normalized[0] in '6'..'9' && normalized.all { it.isDigit() }) {
            null
        } else {
            "Enter a valid 10-digit Indian mobile number"
        }
    }

    private fun isValidEmail(email: String): Boolean =
        android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()
}
