package com.globus.crm.feature.profile.domain.model

data class Profile(
    val patientId: Int,
    val name: String,
    val phone: String?,
    val email: String?,
    val dob: String?,
    val gender: String?,
    val profilePictureUrl: String? = null,
)
