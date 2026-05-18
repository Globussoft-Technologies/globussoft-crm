package com.globussoft.wellness.core.network.model.response

data class ContactResponse(
    val id: String,
    val contactName: String?,
    val name: String?,
    val email: String?,
    val phone: String?,
    val company: String?,
    val status: String?,
    val source: String?,
    val aiScore: Int?,
    val assignedTo: ContactAssigneeResponse?,
    val createdAt: String?,
    val updatedAt: String?,
    val _count: ContactCountResponse?,
)

data class ContactAssigneeResponse(
    val id: String,
    val name: String?,
    val email: String?,
)

data class ContactCountResponse(
    val deals: Int?,
    val activities: Int?,
    val tasks: Int?,
)
