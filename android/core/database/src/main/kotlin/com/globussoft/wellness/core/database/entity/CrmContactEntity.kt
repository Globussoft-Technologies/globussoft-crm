package com.globussoft.wellness.core.database.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "crm_contacts",
    indices = [
        Index(value = ["tenantId", "name"]),
        Index(value = ["tenantId", "status"]),
    ],
)
data class CrmContactEntity(
    @PrimaryKey
    val id: String,
    val tenantId: String,
    val name: String,
    val email: String?,
    val phone: String?,
    val company: String?,
    val status: String?,
    val source: String?,
    val aiScore: Int,
    val assigneeName: String?,
    val dealsCount: Int,
    val createdAt: String?,
    val syncedAt: Long = System.currentTimeMillis(),
)
