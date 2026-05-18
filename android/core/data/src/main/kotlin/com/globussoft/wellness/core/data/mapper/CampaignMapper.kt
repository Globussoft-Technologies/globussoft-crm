package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Campaign
import com.globussoft.wellness.core.network.model.response.CampaignResponse

fun CampaignResponse.toDomain(): Campaign = Campaign(
    id = id,
    name = name ?: "",
    channel = channel ?: "",
    status = status ?: "DRAFT",
    subject = subject,
    audienceSize = audienceSize ?: 0,
    openRate = openRate,
    clickRate = clickRate,
    scheduledAt = scheduledAt,
    sentAt = sentAt,
    createdAt = createdAt,
)
