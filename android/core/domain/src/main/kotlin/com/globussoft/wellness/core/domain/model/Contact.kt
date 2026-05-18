package com.globussoft.wellness.core.domain.model

data class Contact(
    val id: String,
    val name: String,
    val email: String?,
    val phone: String?,
    val company: String?,
    val status: String?,
    val source: String?,
    val aiScore: Int,
    val assigneeName: String?,
    val dealsCount: Int,
    val createdAt: String?,
)
