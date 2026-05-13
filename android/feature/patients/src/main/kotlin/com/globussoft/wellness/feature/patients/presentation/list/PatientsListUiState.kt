package com.globussoft.wellness.feature.patients.presentation.list

import com.globussoft.wellness.core.domain.model.Patient

/**
 * Immutable UI state snapshot for the Patients list screen.
 *
 * The combination of [isLoading], [patients], and [error] drives three
 * distinct render paths:
 *  - [isLoading] && [patients].isEmpty() → full-screen shimmer (initial load)
 *  - [isLoading] && [patients].isNotEmpty() → inline spinner (pagination / refresh)
 *  - [error] != null && [patients].isEmpty() → full-screen error state
 *  - else → patient cards list
 */
data class PatientsListUiState(
    /** Currently displayed patients (all loaded pages combined). */
    val patients: List<Patient> = emptyList(),
    /** Server-reported total patient count for the current search query. */
    val totalCount: Int = 0,
    /** True while an initial load, pagination, or refresh is in flight. */
    val isLoading: Boolean = false,
    /** True while a create or update POST/PUT is in flight. */
    val isCreating: Boolean = false,
    /** Non-null when a load or mutation fails; null on success or while loading. */
    val error: String? = null,
    /** Current value of the search bar (drives debounced API calls). */
    val searchQuery: String = "",
    /** Controls the add/edit ModalBottomSheet visibility. */
    val showAddForm: Boolean = false,
    /** When non-null the form is in edit mode; when null it is in create mode. */
    val editingPatient: Patient? = null,
    /** Mutable fields bound to the add/edit form inputs. */
    val addForm: PatientFormState = PatientFormState(),
    /** Current page offset for infinite scroll (in units of [PAGE_SIZE]). */
    val currentPage: Int = 0,
) {
    companion object {
        const val PAGE_SIZE = 20
    }

    /** True when all pages have been loaded (no more items to fetch). */
    val hasReachedEnd: Boolean
        get() = patients.size >= totalCount && totalCount > 0
}

/**
 * Mutable field state for the add / edit patient form.
 *
 * All optional fields default to an empty string so Compose text fields can
 * bind without null-checks. The mapper ([PatientForm.toRequest]) converts
 * blank strings back to null before sending to the API.
 */
data class PatientFormState(
    val name: String = "",
    val phone: String = "",
    val email: String = "",
    val dob: String = "",
    val gender: String = "",
    val source: String = "",
    val locationId: String = "",
    /** Non-null when the name field has failed validation. */
    val nameError: String? = null,
    /** Non-null when the phone field has failed validation. */
    val phoneError: String? = null,
    /** Non-null when the email field has a format error. */
    val emailError: String? = null,
)

// ─── Events ───────────────────────────────────────────────────────────────────

/** User intents for the Patients list screen. */
sealed class PatientsListEvent {
    /** The user typed in the search bar. */
    data class SearchChanged(val query: String) : PatientsListEvent()

    /** The user tapped "New Patient" FAB or the edit icon on a card. */
    data object ToggleAddForm : PatientsListEvent()

    /** A field inside the add/edit form was changed. [field] is the property name. */
    data class FormFieldChanged(val field: String, val value: String) : PatientsListEvent()

    /** The user tapped "Save" inside the add/edit form. */
    data object SubmitForm : PatientsListEvent()

    /** The user tapped the edit icon on a specific patient card. */
    data class EditPatient(val patient: Patient) : PatientsListEvent()

    /** The user tapped a patient card (navigate to detail). */
    data class SelectPatient(val patient: Patient) : PatientsListEvent()

    /** The list scroll has reached the bottom — load the next page. */
    data object LoadNextPage : PatientsListEvent()

    /** Pull-to-refresh gesture or retry after error. */
    data object Refresh : PatientsListEvent()
}

// ─── Effects ──────────────────────────────────────────────────────────────────

/** One-time side effects emitted by [PatientsListViewModel]. */
sealed class PatientsListEffect {
    /** Navigate to the patient detail screen for [patientId]. */
    data class NavigateToDetail(val patientId: String) : PatientsListEffect()

    /** Show a transient Snackbar with [message]. */
    data class ShowSnackbar(val message: String) : PatientsListEffect()
}
