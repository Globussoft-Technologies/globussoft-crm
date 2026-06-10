package com.globus.crm.feature.notifications.data.remote.dto

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

@JsonClass(generateAdapter = true)
data class PortalNotificationDto(
    val id: String,
    val type: String,
    val title: String,
    @Json(name = "body") val body: String?,
    val screen: String?,
    val entityId: Int?,
    val isRead: Boolean,
    val receivedAt: String,
)

@JsonClass(generateAdapter = true)
data class PortalNotificationsResponseDto(
    val notifications: List<PortalNotificationDto>,
    val total: Int,
    val page: Int,
)
