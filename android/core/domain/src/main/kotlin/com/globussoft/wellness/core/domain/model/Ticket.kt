package com.globussoft.wellness.core.domain.model

data class Ticket(
    val id: String,
    val subject: String,
    val description: String?,
    val status: String,
    val priority: String,
    val breached: Boolean,
    val slaResponseDue: String?,
    val contactName: String?,
    val assigneeName: String?,
    val createdAt: String?,
)
