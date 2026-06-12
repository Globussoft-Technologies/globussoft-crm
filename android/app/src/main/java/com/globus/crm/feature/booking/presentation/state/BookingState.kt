package com.globus.crm.feature.booking.presentation.state

import com.globus.crm.feature.booking.domain.model.Appointment
import com.globus.crm.feature.booking.domain.model.Product
import com.globus.crm.feature.booking.domain.model.ProductCategory
import com.globus.crm.feature.booking.domain.model.Visit

// ── My Appointments ───────────────────────────────────────────────────────────
data class MyAppointmentsUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val upcoming: List<Appointment> = emptyList(),
    val past: List<Appointment> = emptyList(),
    val pending: List<Appointment> = emptyList(),
    val cancelled: List<Appointment> = emptyList(),
    val cancellingId: Int? = null,
    val rescheduleSheetAppointmentId: Int? = null,
    val isRescheduling: Boolean = false,
    val rescheduleError: String? = null,
    val showCancelConfirmDialog: Boolean = false,
    val appointmentToCancel: Appointment? = null,
    val actionSheetAppointment: Appointment? = null,
)

sealed class MyAppointmentsUiEvent {
    object Refresh : MyAppointmentsUiEvent()
    data class ShowActionSheet(val appointment: Appointment) : MyAppointmentsUiEvent()
    object DismissActionSheet : MyAppointmentsUiEvent()
    data class RequestCancel(val appointment: Appointment) : MyAppointmentsUiEvent()
    object ConfirmCancel : MyAppointmentsUiEvent()
    object DismissCancel : MyAppointmentsUiEvent()
    data class Cancel(val appointmentId: Int) : MyAppointmentsUiEvent()
    data class ShowRescheduleSheet(
        val appointmentId: Int,
    ) : MyAppointmentsUiEvent()
    object DismissRescheduleSheet : MyAppointmentsUiEvent()
    data class ConfirmReschedule(
        val newDate: String,
        val newTime: String,
    ) : MyAppointmentsUiEvent()
    object NavigateToBook : MyAppointmentsUiEvent()
    object NavigateToHistory : MyAppointmentsUiEvent()
    object NavigateBack : MyAppointmentsUiEvent()
}

data class DoctorOption(val id: Int?, val name: String)

// ── Book Appointment (4-step) ─────────────────────────────────────────────────
data class BookAppointmentUiState(
    val step: Int = 1,
    val isLoading: Boolean = true,
    val error: String? = null,
    val products: List<Product> = emptyList(),
    val categories: List<ProductCategory> = emptyList(),
    val serviceSearchQuery: String = "",
    val selectedProduct: Product? = null,
    val doctors: List<DoctorOption> = emptyList(),
    val selectedDoctorId: Int? = null,
    val selectedDate: Long? = null,
    val selectedTime: String? = null,
    val reason: String = "",
    val membershipId: Int? = null,
    val isBooking: Boolean = false,
    val bookingSuccess: Appointment? = null,
)

sealed class BookAppointmentUiEvent {
    object LoadProducts : BookAppointmentUiEvent()
    data class UpdateServiceSearch(val query: String) : BookAppointmentUiEvent()
    data class SelectProduct(val product: Product) : BookAppointmentUiEvent()
    data class SelectDoctor(val doctorId: Int?) : BookAppointmentUiEvent()
    data class SelectDate(val epochMs: Long) : BookAppointmentUiEvent()
    data class SelectTime(val time: String) : BookAppointmentUiEvent()
    data class EnterReason(val reason: String) : BookAppointmentUiEvent()
    data class SelectMembership(val membershipId: Int?) : BookAppointmentUiEvent()
    object NextStep : BookAppointmentUiEvent()
    object PreviousStep : BookAppointmentUiEvent()
    object ConfirmBooking : BookAppointmentUiEvent()
    object NavigateBack : BookAppointmentUiEvent()
}

// ── Visit History ─────────────────────────────────────────────────────────────
data class VisitHistoryUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val visits: List<Visit> = emptyList(),
    val selectedVisit: Visit? = null,
)

sealed class VisitHistoryUiEvent {
    object Refresh : VisitHistoryUiEvent()
    data class SelectVisit(val visit: Visit) : VisitHistoryUiEvent()
    object DismissDetail : VisitHistoryUiEvent()
    object NavigateBack : VisitHistoryUiEvent()
}
