package com.globussoft.wellness.core.network.model.response

data class CrmTaskResponse(
    val id: String,
    val title: String?,
    val description: String?,
    val status: String?,
    val dueDate: String?,
    val contact: CrmTaskContactResponse?,
    val assignee: CrmTaskAssigneeResponse?,
    val createdAt: String?,
)

data class CrmTaskContactResponse(
    val id: String,
    val contactName: String?,
    val name: String?,
)

data class CrmTaskAssigneeResponse(
    val id: String,
    val name: String?,
)
