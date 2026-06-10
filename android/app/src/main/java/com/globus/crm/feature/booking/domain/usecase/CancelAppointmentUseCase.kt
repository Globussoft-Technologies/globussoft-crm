package com.globus.crm.feature.booking.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.booking.domain.model.Appointment
import com.globus.crm.feature.booking.domain.repository.AppointmentRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class CancelAppointmentUseCase @Inject constructor(
    private val repository: AppointmentRepository,
) {
    suspend operator fun invoke(appointmentId: Int): Result<Appointment> = try {
        Result.Success(repository.cancelAppointment(appointmentId))
    } catch (e: HttpException) {
        when (e.code()) {
            403 -> Result.Error("FORBIDDEN", "You can only cancel your own appointments", 403)
            404 -> Result.Error("NOT_FOUND", "Appointment not found", 404)
            else -> Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
        }
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
