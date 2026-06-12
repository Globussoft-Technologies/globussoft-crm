package com.globus.crm.feature.dashboard.domain.model

data class Dashboard(
    val patientName: String,
    val nextVisit: UpcomingVisit?,
    val walletBalance: Long?,
    val walletCurrency: String?,
    val activeMembershipCount: Int,
    val loyaltyPoints: Int?,
)

data class UpcomingVisit(
    val id: Int,
    val visitDate: String,
    val serviceName: String?,
    val doctorName: String?,
    val status: String,
)
