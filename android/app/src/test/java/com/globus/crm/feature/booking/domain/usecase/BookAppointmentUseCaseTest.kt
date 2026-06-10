package com.globus.crm.feature.booking.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.booking.domain.model.Appointment
import com.globus.crm.feature.booking.domain.repository.AppointmentRepository
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException

class BookAppointmentUseCaseTest {

    private lateinit var repository: AppointmentRepository
    private lateinit var useCase: BookAppointmentUseCase

    private val fakeAppointment = Appointment(
        id = 42,
        doctorName = "Dr. Smith",
        serviceName = "Consultation",
        appointmentDate = "2026-06-15T10:00:00Z",
        status = "booked",
        reason = "Routine checkup",
        doctorAssigned = false,
        bookingType = "in-person",
        videoCallUrl = null,
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = BookAppointmentUseCase(repository)
    }

    @Test
    fun `returns Success on successful booking`() = runTest {
        coEvery { repository.bookAppointment(any(), any(), any(), any(), any(), any()) } returns fakeAppointment
        val result = useCase("2026-06-15", "10:00", "Routine checkup")
        assertTrue(result is Result.Success)
        assertEquals(fakeAppointment, (result as Result.Success).data)
    }

    @Test
    fun `returns MISSING_FIELDS on 400`() = runTest {
        val response = Response.error<Appointment>(400, "".toResponseBody())
        coEvery { repository.bookAppointment(any(), any(), any(), any(), any(), any()) } throws HttpException(response)
        val result = useCase("2026-06-15", "10:00", "")
        assertTrue(result is Result.Error)
        assertEquals("MISSING_FIELDS", (result as Result.Error).code)
    }

    @Test
    fun `returns DOCTOR_UNAVAILABLE on 409`() = runTest {
        val response = Response.error<Appointment>(409, "".toResponseBody())
        coEvery { repository.bookAppointment(any(), any(), any(), any(), any(), any()) } throws HttpException(response)
        val result = useCase("2026-06-15", "10:00", "Checkup")
        assertTrue(result is Result.Error)
        assertEquals("DOCTOR_UNAVAILABLE", (result as Result.Error).code)
    }

    @Test
    fun `returns NETWORK_ERROR on IOException`() = runTest {
        coEvery { repository.bookAppointment(any(), any(), any(), any(), any(), any()) } throws IOException()
        val result = useCase("2026-06-15", "10:00", "Checkup")
        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }
}
