package com.globussoft.wellness.core.domain.model

data class Approval(
    val id: String,
    val type: String,
    val status: String,
    val requesterName: String?,
    val approverName: String?,
    val comments: String?,
    val createdAt: String?,
) {
    val isPending: Boolean get() = status == "PENDING"
    val isApproved: Boolean get() = status == "APPROVED"
    val isRejected: Boolean get() = status == "REJECTED"
}
