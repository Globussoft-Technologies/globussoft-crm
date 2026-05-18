package com.globussoft.wellness.core.network.model.response

data class CampaignResponse(
    val id: String,
    val name: String?,
    val channel: String?,
    val status: String?,
    val subject: String?,
    val body: String?,
    val audienceSize: Int?,
    val sentCount: Int?,
    val openRate: Double?,
    val clickRate: Double?,
    val scheduledAt: String?,
    val sentAt: String?,
    val createdAt: String?,
)
