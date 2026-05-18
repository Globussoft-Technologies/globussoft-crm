package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Ticket
import com.globussoft.wellness.core.network.model.response.TicketResponse

fun TicketResponse.toDomain(): Ticket = Ticket(
    id = id,
    subject = subject ?: "",
    description = description,
    status = status ?: "OPEN",
    priority = priority ?: "MEDIUM",
    breached = breached ?: false,
    slaResponseDue = slaResponseDue,
    contactName = contact?.name ?: contact?.contactName,
    assigneeName = assignedTo?.name,
    createdAt = createdAt,
)
