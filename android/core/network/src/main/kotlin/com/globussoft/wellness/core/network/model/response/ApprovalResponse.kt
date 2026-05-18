package com.globussoft.wellness.core.network.model.response

data class ApprovalResponse(
    val id: String,
    val type: String?,
    val status: String?,
    val comments: String?,
    val metadata: String?,
    val createdAt: String?,
    val updatedAt: String?,
)
