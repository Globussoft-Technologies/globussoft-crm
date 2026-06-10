package com.globus.crm.feature.booking.domain.repository

import com.globus.crm.feature.booking.domain.model.Appointment
import com.globus.crm.feature.booking.domain.model.Product
import com.globus.crm.feature.booking.domain.model.ProductCategory
import com.globus.crm.feature.booking.domain.model.Visit
import com.globus.crm.feature.booking.domain.model.WaitlistEntry

interface AppointmentRepository {
    suspend fun getMyAppointments(bucket: String? = null): List<Appointment>
    suspend fun bookAppointment(
        appointmentDate: String,
        appointmentTime: String,
        reason: String,
        serviceId: Int? = null,
        membershipId: Int? = null,
        bookingType: String? = null,
        doctorId: Int? = null,
    ): Appointment
    suspend fun cancelAppointment(appointmentId: Int): Appointment
    suspend fun rescheduleAppointment(
        appointmentId: Int,
        appointmentDate: String,
        appointmentTime: String,
    ): Appointment
    suspend fun getPortalProducts(): List<Product>
    suspend fun getPortalProductCategories(): List<ProductCategory>
    suspend fun getVisitHistory(upcomingOnly: Boolean = false): List<Visit>
    suspend fun getCachedVisits(): List<Visit>
    suspend fun cacheVisits(visits: List<Visit>)
    suspend fun getWaitlist(): List<WaitlistEntry>
    suspend fun addToWaitlist(serviceId: Int, patientId: Int, notes: String?): WaitlistEntry
}
