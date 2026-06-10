package com.globus.crm.feature.health.domain.model

data class TreatmentPlan(
    val id: Int,
    val name: String,
    val totalSessions: Int,
    val completedSessions: Int,
    val startedAt: String,
    val nextDueAt: String?,
    val status: String,
    val totalPrice: Double,
    val serviceName: String?,
    val serviceCategory: String?,
)
