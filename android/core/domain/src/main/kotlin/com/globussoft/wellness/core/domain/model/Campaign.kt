package com.globussoft.wellness.core.domain.model

data class Campaign(
    val id: String,
    val name: String,
    val channel: String,
    val status: String,
    val subject: String?,
    val audienceSize: Int,
    val openRate: Double?,
    val clickRate: Double?,
    val scheduledAt: String?,
    val sentAt: String?,
    val createdAt: String?,
) {
    val isDraft: Boolean get() = status == "DRAFT"
    val isScheduled: Boolean get() = status == "SCHEDULED"
    val isSent: Boolean get() = status == "SENT"
}
