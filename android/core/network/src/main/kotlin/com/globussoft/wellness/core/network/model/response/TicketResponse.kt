package com.globussoft.wellness.core.network.model.response

data class TicketResponse(
    val id: String,
    val subject: String?,
    val description: String?,
    val status: String?,
    val priority: String?,
    val breached: Boolean?,
    val slaResponseDue: String?,
    val slaResolveDue: String?,
    val contact: TicketContactResponse?,
    val assignedTo: TicketAssigneeResponse?,
    val comments: List<TicketCommentResponse>?,
    val createdAt: String?,
    val updatedAt: String?,
)

data class TicketContactResponse(
    val id: String,
    val contactName: String?,
    val name: String?,
)

data class TicketAssigneeResponse(
    val id: String,
    val name: String?,
)

data class TicketCommentResponse(
    val id: String,
    val body: String?,
    val author: TicketAssigneeResponse?,
    val createdAt: String?,
)
