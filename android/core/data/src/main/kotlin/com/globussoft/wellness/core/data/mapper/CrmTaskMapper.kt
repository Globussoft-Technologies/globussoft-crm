package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.CrmTask
import com.globussoft.wellness.core.network.model.response.CrmTaskResponse

fun CrmTaskResponse.toDomain(): CrmTask = CrmTask(
    id = id,
    title = title ?: "",
    description = description,
    status = status ?: "PENDING",
    priority = priority,
    dueDate = dueDate,
    contactName = contact?.name,
    assigneeName = assignee?.name,
    createdAt = createdAt,
)
