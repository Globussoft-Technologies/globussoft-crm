package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Contact
import com.globussoft.wellness.core.network.model.response.ContactResponse

fun ContactResponse.toDomain(): Contact = Contact(
    id = id,
    name = name ?: contactName ?: "",
    email = email,
    phone = phone,
    company = company,
    status = status ?: "Contact",
    source = source,
    aiScore = aiScore ?: 0,
    assigneeName = assignedTo?.name,
    dealsCount = _count?.deals ?: 0,
    createdAt = createdAt,
)
