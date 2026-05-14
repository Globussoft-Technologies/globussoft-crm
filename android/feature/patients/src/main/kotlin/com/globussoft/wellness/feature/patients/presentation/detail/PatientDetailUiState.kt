package com.globussoft.wellness.feature.patients.presentation.detail

import com.globussoft.wellness.core.domain.model.Patient
import com.globussoft.wellness.core.domain.model.Prescription
import com.globussoft.wellness.core.domain.model.Service
import com.globussoft.wellness.core.domain.model.Staff
import com.globussoft.wellness.core.domain.model.TreatmentPlan
import com.globussoft.wellness.core.domain.model.Visit

/**
 * Immutable UI state snapshot for the Patient detail screen.
 *
 * [patient] is null during initial load and after a hard error. The screen
 * uses [isLoading] + [patient] + [error] to switch between shimmer / content /
 * error render paths.
 *
 * [visits], [services], and [doctors] are loaded in parallel with the patient
 * so the tabs can render without a secondary loading round-trip.
 *
 * [selectedTabIndex] is persisted to [SavedStateHandle] by the ViewModel so it
 * survives configuration changes (screen rotation, multi-window resize).
 */
data class PatientDetailUiState(
    val isLoading: Boolean = false,
    val patient: Patient? = null,
    val error: String? = null,
    val selectedTabIndex: Int = 0,
    val visits: List<Visit> = emptyList(),
    val services: List<Service> = emptyList(),
    val doctors: List<Staff> = emptyList(),
    val prescriptions: List<Prescription> = emptyList(),
    val treatmentPlans: List<TreatmentPlan> = emptyList(),
    /** True while a new visit is being saved via the Log Visit tab. */
    val isLoggingVisit: Boolean = false,
    /** Non-null when a log-visit mutation fails. */
    val logVisitError: String? = null,
    /** True while a new prescription is being created. */
    val isCreatingRx: Boolean = false,
    /** Non-null when prescription creation fails. */
    val createRxError: String? = null,
    /** True while a new treatment plan is being created. */
    val isCreatingPlan: Boolean = false,
    /** Non-null when treatment plan creation fails. */
    val createPlanError: String? = null,
    /** True while a gift-card redeem request is in-flight. */
    val isRedeeming: Boolean = false,
)

// ─── Events ───────────────────────────────────────────────────────────────────

/** User intents for the Patient detail screen. */
sealed class PatientDetailEvent {
    /** The user tapped a tab. */
    data class TabSelected(val index: Int) : PatientDetailEvent()

    /** Pull-to-refresh or retry after error. */
    data object Refresh : PatientDetailEvent()

    /**
     * The user submitted the Log Visit form.
     *
     * @param serviceId  Selected service UUID.
     * @param doctorId   Selected doctor UUID (empty string if none selected).
     * @param date       ISO-8601 date string (e.g. "2026-05-13").
     * @param bookingType One of "CLINIC_VISIT" | "AT_HOME" | "VIDEO" | "PHONE".
     * @param notes      Free-text notes (may be blank).
     */
    data class LogVisit(
        val serviceId: String,
        val doctorId: String,
        val date: String,
        val bookingType: String,
        val notes: String,
    ) : PatientDetailEvent()

    /**
     * The user submitted the New Prescription form.
     *
     * [visitId] must be an existing visit ID — the backend requires it.
     * [drugName] is the primary drug (the form captures one drug at a time).
     */
    data class CreatePrescription(
        val visitId: String,
        val drugName: String,
        val dosage: String,
        val frequency: String,
        val duration: String,
        val instructions: String,
    ) : PatientDetailEvent()

    /**
     * The user submitted the New Treatment Plan form.
     */
    data class CreateTreatmentPlan(
        val name: String,
        val totalSessions: Int,
        val serviceId: String,
        val totalPrice: String,
    ) : PatientDetailEvent()

    /**
     * The user tapped "Redeem" in the Wallet tab.
     *
     * @param code Gift-card code entered by the user.
     */
    data class RedeemGiftCard(val code: String) : PatientDetailEvent()
}

// ─── Effects ──────────────────────────────────────────────────────────────────

/** One-time side effects emitted by [PatientDetailViewModel]. */
sealed class PatientDetailEffect {
    /** Show a transient Snackbar message. */
    data class ShowSnackbar(val message: String) : PatientDetailEffect()
}
