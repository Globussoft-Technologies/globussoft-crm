package com.globus.crm.feature.booking.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.booking.domain.model.Appointment
import com.globus.crm.feature.booking.domain.repository.AppointmentRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class RescheduleAppointmentUseCase @Inject constructor(
    private val repository: AppointmentRepository,
) {
    suspend operator fun invoke(
        appointmentId: Int,
        appointmentDate: String,
        appointmentTime: String,
    ): Result<Appointment> = try {
        Result.Success(repository.rescheduleAppointment(appointmentId, appointmentDate, appointmentTime))
    } catch (e: HttpException) {
        when (e.code()) {
            409 -> Result.Error("SLOT_TAKEN", "This slot is no longer available", 409)
            404 -> Result.Error("NOT_FOUND", "Appointment not found", 404)
            else -> Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
        }
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
