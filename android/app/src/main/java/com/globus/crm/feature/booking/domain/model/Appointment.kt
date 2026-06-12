package com.globus.crm.feature.booking.domain.model

data class Appointment(
    val id: Int,
    val doctorName: String?,
    val serviceName: String?,
    val appointmentDate: String,
    val status: String,
    val reason: String?,
    val doctorAssigned: Boolean,
    val bookingType: String?,
    val videoCallUrl: String?,
    val canCancel: Boolean = true,
    val canReschedule: Boolean = true,
)

data class Visit(
    val id: Int,
    val visitDate: String,
    val status: String,
    val serviceName: String?,
    val doctorName: String?,
    val locationName: String?,
    val bookingType: String?,
    val videoCallUrl: String?,
    val amountCharged: Double?,
)

data class Product(
    val id: Int,
    val name: String,
    val description: String?,
    val price: Double?,
    val discountedPrice: Double?,
    val imageUrl: String?,
    val categoryName: String?,
)

data class ProductCategory(
    val id: Int,
    val name: String,
    val imageUrl: String?,
    val color: String?,
)

data class WaitlistEntry(
    val id: Int,
    val serviceId: Int?,
    val serviceName: String?,
    val status: String,
    val notes: String?,
    val createdAt: String,
)
