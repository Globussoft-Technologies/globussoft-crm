package com.globussoft.wellness.core.network.model.request

data class CreateContactRequest(
    val contactName: String,
    val email: String?,
    val phone: String?,
    val company: String?,
    val source: String?,
    val status: String? = "Contact",
)
