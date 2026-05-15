package com.globussoft.wellness.feature.crm.presentation.tickets

import com.globussoft.wellness.core.domain.model.Ticket

data class TicketComment(
    val id: String,
    val author: String,
    val body: String,
    val createdAt: String,
)

data class TicketDetailUiState(
    val isLoading: Boolean = true,
    val ticket: Ticket? = null,
    val comments: List<TicketComment> = emptyList(),
    val error: String? = null,
    val replyText: String = "",
    val isSendingReply: Boolean = false,
    val showStatusSheet: Boolean = false,
    val isUpdating: Boolean = false,
)
