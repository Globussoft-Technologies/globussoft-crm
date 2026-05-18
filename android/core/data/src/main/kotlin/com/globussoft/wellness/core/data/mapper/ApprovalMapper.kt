package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Approval
import com.globussoft.wellness.core.network.model.response.ApprovalResponse

fun ApprovalResponse.toDomain(): Approval = Approval(
    id = id,
    type = type ?: "",
    status = status ?: "PENDING",
    requesterName = null,
    approverName = null,
    comments = comments,
    createdAt = createdAt,
)
