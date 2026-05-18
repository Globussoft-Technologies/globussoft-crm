package com.globussoft.wellness.feature.crm.presentation.inbox

data class InboxUiState(
    val selectedTab: Int = 0,

    val emails: List<Map<String, Any>>        = emptyList(),
    val smsMessages: List<Map<String, Any>>   = emptyList(),
    val whatsapp: List<Map<String, Any>>      = emptyList(),
    val notifications: List<Map<String, Any>> = emptyList(),

    val isLoadingEmail:         Boolean = false,
    val isLoadingSms:           Boolean = false,
    val isLoadingWhatsapp:      Boolean = false,
    val isLoadingNotifications: Boolean = false,

    val errorEmail:         String? = null,
    val errorSms:           String? = null,
    val errorWhatsapp:      String? = null,
    val errorNotifications: String? = null,
)
