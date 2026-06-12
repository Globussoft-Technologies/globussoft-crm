package com.globus.crm.feature.health.presentation.state

import com.globus.crm.feature.health.domain.model.ConsentForm
import com.globus.crm.feature.health.domain.model.Prescription
import com.globus.crm.feature.health.domain.model.TreatmentPlan

data class PrescriptionsUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val prescriptions: List<Prescription> = emptyList(),
    val permissionBlocked: Boolean = false,
    val showPdfConfirm: Boolean = false,
    val prescriptionToOpen: Int? = null,
)

sealed class PrescriptionsUiEvent {
    object Refresh : PrescriptionsUiEvent()
    data class RequestViewPdf(val prescriptionId: Int) : PrescriptionsUiEvent()
    object ConfirmViewPdf : PrescriptionsUiEvent()
    object DismissPdfConfirm : PrescriptionsUiEvent()
    data class ViewPdf(val prescriptionId: Int) : PrescriptionsUiEvent()
    object NavigateBack : PrescriptionsUiEvent()
}

data class PrescriptionPdfUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val pdfBytes: ByteArray? = null,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PrescriptionPdfUiState) return false
        return isLoading == other.isLoading && error == other.error && pdfBytes.contentEquals(other.pdfBytes)
    }
    override fun hashCode(): Int = 31 * isLoading.hashCode() + (pdfBytes?.contentHashCode() ?: 0)
}

private fun ByteArray?.contentEquals(other: ByteArray?): Boolean {
    if (this == null && other == null) return true
    if (this == null || other == null) return false
    return this.contentEquals(other)
}

sealed class PrescriptionPdfUiEvent {
    object NavigateBack : PrescriptionPdfUiEvent()
}

// ── Treatment Plans ───────────────────────────────────────────────────────────

data class TreatmentPlansUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val plans: List<TreatmentPlan> = emptyList(),
)

sealed class TreatmentPlansUiEvent {
    object Refresh : TreatmentPlansUiEvent()
    object NavigateBack : TreatmentPlansUiEvent()
}

// ── Consent Forms ─────────────────────────────────────────────────────────────

data class ConsentFormsUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val forms: List<ConsentForm> = emptyList(),
)

sealed class ConsentFormsUiEvent {
    object Refresh : ConsentFormsUiEvent()
    data class ViewPdf(val consentId: Int) : ConsentFormsUiEvent()
    object NavigateBack : ConsentFormsUiEvent()
}

data class ConsentFormPdfUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val pdfBytes: ByteArray? = null,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ConsentFormPdfUiState) return false
        return isLoading == other.isLoading && error == other.error &&
            pdfBytes.contentEquals(other.pdfBytes)
    }
    override fun hashCode(): Int = 31 * isLoading.hashCode() + (pdfBytes?.contentHashCode() ?: 0)
}

sealed class ConsentFormPdfUiEvent {
    object NavigateBack : ConsentFormPdfUiEvent()
}
