package com.globus.crm.feature.notifications.presentation.state

data class NotificationCategory(val key: String, val label: String, val enabled: Boolean = true)
data class NotificationChannel(val key: String, val label: String, val enabled: Boolean = true)

data class NotificationSettingsUiState(
    val categories: List<NotificationCategory> = listOf(
        NotificationCategory("appointment_reminders", "Appointment reminders & changes"),
        NotificationCategory("prescription_ready", "Prescription ready"),
        NotificationCategory("payment_receipts", "Payment & transaction receipts"),
        NotificationCategory("membership_updates", "Membership updates"),
        NotificationCategory("gift_card_activity", "Gift card activity"),
    ),
    val channels: List<NotificationChannel> = listOf(
        NotificationChannel("in_app", "In-App Bell"),
        NotificationChannel("push", "Push Notifications"),
        NotificationChannel("email", "Email"),
    ),
    val quietStart: String = "22:00",
    val quietEnd: String = "07:00",
    val isSaving: Boolean = false,
    val saveSuccess: Boolean = false,
)

sealed class NotificationSettingsUiEvent {
    data class ToggleCategory(val key: String, val enabled: Boolean) : NotificationSettingsUiEvent()
    data class ToggleChannel(val key: String, val enabled: Boolean) : NotificationSettingsUiEvent()
    data class SetQuietStart(val time: String) : NotificationSettingsUiEvent()
    data class SetQuietEnd(val time: String) : NotificationSettingsUiEvent()
    object Save : NotificationSettingsUiEvent()
}
