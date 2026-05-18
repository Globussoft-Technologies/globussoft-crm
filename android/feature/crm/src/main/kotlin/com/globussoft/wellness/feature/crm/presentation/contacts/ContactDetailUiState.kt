package com.globussoft.wellness.feature.crm.presentation.contacts

import com.globussoft.wellness.core.domain.model.Contact
import com.globussoft.wellness.core.domain.model.CrmTask
import com.globussoft.wellness.core.domain.model.Deal

data class ContactDetailUiState(
    val isLoading: Boolean = true,
    val contact: Contact? = null,
    val deals: List<Deal> = emptyList(),
    val tasks: List<CrmTask> = emptyList(),
    val activities: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showEditForm: Boolean = false,
    val showLogActivity: Boolean = false,
    val isUpdating: Boolean = false,
    val isLoggingActivity: Boolean = false,
    val formError: String? = null,
)
