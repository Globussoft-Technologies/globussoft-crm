package com.globussoft.wellness.core.database.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "crm_tickets",
    indices = [
        Index(value = ["tenantId", "status"]),
        Index(value = ["tenantId", "priority"]),
    ],
)
data class CrmTicketEntity(
    @PrimaryKey
    val id: String,
    val tenantId: String,
    val title: String,
    val description: String?,
    val status: String,
    val priority: String,
    val assigneeName: String?,
    val contactName: String?,
    val slaBreached: Boolean,
    val createdAt: String?,
    val syncedAt: Long = System.currentTimeMillis(),
)
