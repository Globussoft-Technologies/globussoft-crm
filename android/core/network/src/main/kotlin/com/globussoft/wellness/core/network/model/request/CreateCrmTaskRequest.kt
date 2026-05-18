package com.globussoft.wellness.core.network.model.request

data class CreateCrmTaskRequest(
    val title: String,
    val description: String?,
    val dueDate: String?,
    val contactId: String?,
    val assigneeId: String?,
    val priority: String?,
)
