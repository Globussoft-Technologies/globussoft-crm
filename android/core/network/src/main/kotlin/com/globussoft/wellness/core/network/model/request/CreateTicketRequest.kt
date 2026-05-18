package com.globussoft.wellness.core.network.model.request

data class CreateTicketRequest(
    val subject: String,
    val description: String?,
    val priority: String?,
    val contactId: String?,
)
