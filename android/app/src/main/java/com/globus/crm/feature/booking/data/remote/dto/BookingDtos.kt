package com.globus.crm.feature.booking.data.remote.dto

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

@JsonClass(generateAdapter = true)
data class VisitDto(
    val id: Int,
    val visitDate: String,
    val status: String,
    val service: ServiceRefDto?,
    val doctor: DoctorRefDto?,
    val locationName: String?,
    val bookingType: String?,
    val videoCallUrl: String?,
    val amountCharged: Double?,
)

@JsonClass(generateAdapter = true)
data class ServiceRefDto(
    val id: Int,
    val name: String,
)

@JsonClass(generateAdapter = true)
data class DoctorRefDto(
    val id: Int,
    val name: String,
)

@JsonClass(generateAdapter = true)
data class ServiceDto(
    val id: Int,
    val name: String,
    val description: String?,
    val duration: Int?,
    val price: Double?,
)

@JsonClass(generateAdapter = true)
data class LocationDto(
    val id: Int,
    val name: String,
    val address: String?,
    val phone: String?,
)

@JsonClass(generateAdapter = true)
data class SlotDto(
    val date: String,
    val time: String,
    val doctorId: Int?,
    val doctorName: String?,
    val available: Boolean,
)

@JsonClass(generateAdapter = true)
data class AppointmentDto(
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

@JsonClass(generateAdapter = true)
data class BookAppointmentDto(
    val appointmentDate: String,
    val appointmentTime: String,
    val reason: String,
    val doctorId: Int?,
    val serviceId: Int?,
    val membershipId: Int?,
    val bookingType: String? = null,
)

@JsonClass(generateAdapter = true)
data class BookAppointmentResponseDto(
    val success: Boolean,
    val appointment: AppointmentDto,
)

@JsonClass(generateAdapter = true)
data class CancelAppointmentResponseDto(
    val success: Boolean,
    val appointment: AppointmentDto,
)

@JsonClass(generateAdapter = true)
data class AppointmentListResponseDto(
    val bucket: String,
    val count: Int,
    val appointments: List<AppointmentDto>,
)

@JsonClass(generateAdapter = true)
data class RescheduleAppointmentDto(
    val appointmentDate: String,
    val appointmentTime: String,
)

@JsonClass(generateAdapter = true)
data class RescheduleAppointmentResponseDto(
    val success: Boolean,
    val appointment: AppointmentDto,
)

@JsonClass(generateAdapter = true)
data class ProductCategoryRefDto(
    val id: Int,
    val name: String,
)

@JsonClass(generateAdapter = true)
data class ProductDto(
    val id: Int,
    val name: String,
    val description: String?,
    @Json(name = "basePrice") val price: Double?,
    val discountedPrice: Double?,
    val imageUrl: String?,
    val brandName: String?,
    val volume: String?,
    val unit: String?,
    @Json(name = "category") val categoryName: String?,
)

@JsonClass(generateAdapter = true)
data class ProductCategoryDto(
    val id: Int,
    val name: String,
    val parentId: Int?,
    val imageUrl: String?,
    val color: String?,
)

@JsonClass(generateAdapter = true)
data class WaitlistEntryDto(
    val id: Int,
    val serviceId: Int?,
    val serviceName: String?,
    val status: String?,       // pending | notified | cancelled
    val notes: String?,
    val createdAt: String?,
)

@JsonClass(generateAdapter = true)
data class AddWaitlistDto(
    val serviceId: Int,
    val patientId: Int,
    val notes: String?,
)

@JsonClass(generateAdapter = true)
data class DoctorAvailabilityDto(
    val id: Int,
    val name: String,
    val specialization: String?,
    val available: Boolean = true,
)
