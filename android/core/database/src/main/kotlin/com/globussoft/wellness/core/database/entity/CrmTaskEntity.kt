package com.globussoft.wellness.core.database.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "crm_tasks",
    indices = [
        Index(value = ["tenantId", "status"]),
        Index(value = ["tenantId", "dueDate"]),
    ],
)
data class CrmTaskEntity(
    @PrimaryKey
    val id: String,
    val tenantId: String,
    val title: String,
    val description: String?,
    val status: String,
    val priority: String?,
    val dueDate: String?,
    val assigneeName: String?,
    val contactId: String?,
    val dealId: String?,
    val createdAt: String?,
    val syncedAt: Long = System.currentTimeMillis(),
)
