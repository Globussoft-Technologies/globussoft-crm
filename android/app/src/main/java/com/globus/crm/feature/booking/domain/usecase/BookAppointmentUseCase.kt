package com.globus.crm.feature.booking.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.booking.domain.model.Appointment
import com.globus.crm.feature.booking.domain.repository.AppointmentRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class BookAppointmentUseCase @Inject constructor(
    private val repository: AppointmentRepository,
) {
    suspend operator fun invoke(
        appointmentDate: String,
        appointmentTime: String,
        reason: String,
        serviceId: Int? = null,
        membershipId: Int? = null,
        bookingType: String? = null,
        doctorId: Int? = null,
    ): Result<Appointment> = try {
        Result.Success(
            repository.bookAppointment(
                appointmentDate = appointmentDate,
                appointmentTime = appointmentTime,
                reason = reason,
                serviceId = serviceId,
                membershipId = membershipId,
                bookingType = bookingType,
                doctorId = doctorId,
            )
        )
    } catch (e: HttpException) {
        when (e.code()) {
            400 -> {
                val body = runCatching { e.response()?.errorBody()?.string() }.getOrNull() ?: ""
                val msg = when {
                    "INVALID_DATE" in body -> "Invalid appointment date. Please try again."
                    else -> "Please fill in all required fields"
                }
                Result.Error("MISSING_FIELDS", msg, 400)
            }
            409 -> Result.Error("DOCTOR_UNAVAILABLE", "This slot is no longer available", 409)
            else -> Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
        }
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
