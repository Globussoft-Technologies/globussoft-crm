package com.globussoft.wellness.core.domain.model

data class CrmTask(
    val id: String,
    val title: String,
    val description: String?,
    val status: String,
    val dueDate: String?,
    val contactName: String?,
    val assigneeName: String?,
    val createdAt: String?,
) {
    val isPending: Boolean get() = status == "PENDING"
    val isOverdue: Boolean get() = dueDate != null && status == "PENDING"
}
