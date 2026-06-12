package com.globus.crm.feature.booking.data.mapper

import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.booking.data.local.entity.CachedVisit
import com.globus.crm.feature.booking.data.remote.dto.AppointmentDto
import com.globus.crm.feature.booking.data.remote.dto.ProductCategoryDto
import com.globus.crm.feature.booking.data.remote.dto.ProductDto
import com.globus.crm.feature.booking.data.remote.dto.VisitDto
import com.globus.crm.feature.booking.data.remote.dto.WaitlistEntryDto
import com.globus.crm.feature.booking.domain.model.Appointment
import com.globus.crm.feature.booking.domain.model.Product
import com.globus.crm.feature.booking.domain.model.ProductCategory
import com.globus.crm.feature.booking.domain.model.Visit
import com.globus.crm.feature.booking.domain.model.WaitlistEntry

fun AppointmentDto.toDomain() = Appointment(
    id = id,
    doctorName = doctorName,
    serviceName = serviceName,
    appointmentDate = appointmentDate,
    status = status,
    reason = reason,
    doctorAssigned = doctorAssigned,
    bookingType = bookingType,
    videoCallUrl = videoCallUrl,
    canCancel = canCancel,
    canReschedule = canReschedule,
)

fun VisitDto.toDomain() = Visit(
    id = id,
    visitDate = visitDate,
    status = status,
    serviceName = service?.name,
    doctorName = doctor?.name,
    locationName = locationName,
    bookingType = bookingType,
    videoCallUrl = videoCallUrl,
    amountCharged = amountCharged,
)

fun CachedVisit.toDomain() = Visit(
    id = id,
    visitDate = DateUtil.epochMsToIso(visitDate),
    status = status,
    serviceName = serviceName,
    doctorName = doctorName,
    locationName = locationName,
    bookingType = bookingType,
    videoCallUrl = videoCallUrl,
    amountCharged = amountCharged,
)

fun Visit.toEntity() = CachedVisit(
    id = id,
    visitDate = DateUtil.isoToEpochMs(visitDate),
    status = status,
    serviceName = serviceName,
    doctorName = doctorName,
    locationName = locationName,
    bookingType = bookingType,
    videoCallUrl = videoCallUrl,
    amountCharged = amountCharged,
    cachedAt = System.currentTimeMillis(),
)

fun ProductDto.toDomain() = Product(
    id = id,
    name = name,
    description = description,
    price = price,
    discountedPrice = discountedPrice,
    imageUrl = imageUrl,
    categoryName = categoryName,
)

fun ProductCategoryDto.toDomain() = ProductCategory(
    id = id,
    name = name,
    imageUrl = imageUrl,
    color = color,
)

fun WaitlistEntryDto.toDomain() = WaitlistEntry(
    id = id,
    serviceId = serviceId,
    serviceName = serviceName,
    status = status ?: "pending",
    notes = notes,
    createdAt = createdAt ?: "",
)
