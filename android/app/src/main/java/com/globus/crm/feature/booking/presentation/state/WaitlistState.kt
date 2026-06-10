package com.globus.crm.feature.booking.presentation.state

import com.globus.crm.feature.booking.domain.model.Product
import com.globus.crm.feature.booking.domain.model.WaitlistEntry

data class WaitlistUiState(
    val isLoading: Boolean = false,
    val error: String? = null,
    val entries: List<WaitlistEntry> = emptyList(),
    val services: List<Product> = emptyList(),
    // Form state
    val showAddSheet: Boolean = false,
    val selectedServiceId: Int? = null,
    val formNotes: String = "",
    val isSubmitting: Boolean = false,
    val formError: String? = null,
)

sealed class WaitlistUiEvent {
    object Load : WaitlistUiEvent()
    object ShowAddSheet : WaitlistUiEvent()
    object DismissAddSheet : WaitlistUiEvent()
    data class SelectService(val serviceId: Int) : WaitlistUiEvent()
    data class UpdateNotes(val notes: String) : WaitlistUiEvent()
    object SubmitWaitlist : WaitlistUiEvent()
    data class CancelEntry(val entryId: Int) : WaitlistUiEvent()
}
