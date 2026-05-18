package com.globussoft.wellness.core.database.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "crm_deals",
    indices = [
        Index(value = ["tenantId", "status"]),
        Index(value = ["tenantId", "stage"]),
    ],
)
data class CrmDealEntity(
    @PrimaryKey
    val id: String,
    val tenantId: String,
    val title: String,
    val amount: Double,
    val stage: String,
    val status: String,
    val probability: Int,
    val pipelineId: String?,
    val pipelineName: String?,
    val contactId: String?,
    val contactName: String?,
    val ownerId: String?,
    val ownerName: String?,
    val expectedClose: String?,
    val notes: String?,
    val createdAt: String?,
    val syncedAt: Long = System.currentTimeMillis(),
)
