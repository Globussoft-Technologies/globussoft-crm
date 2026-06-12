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

class GetMyAppointmentsUseCaseTest {

    private lateinit var repository: AppointmentRepository
    private lateinit var useCase: GetMyAppointmentsUseCase

    private val fakeAppointment = Appointment(
        id = 1,
        doctorName = "Dr. Smith",
        serviceName = "Consultation",
        appointmentDate = "2026-06-10T10:00:00Z",
        status = "booked",
        reason = "Checkup",
        doctorAssigned = true,
        bookingType = "in-person",
        videoCallUrl = null,
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = GetMyAppointmentsUseCase(repository)
    }

    @Test
    fun `returns Success with appointment list`() = runTest {
        coEvery { repository.getMyAppointments(null) } returns listOf(fakeAppointment)
        val result = useCase()
        assertTrue(result is Result.Success)
        assertEquals(listOf(fakeAppointment), (result as Result.Success).data)
    }

    @Test
    fun `returns Success with empty list when no appointments`() = runTest {
        coEvery { repository.getMyAppointments(null) } returns emptyList()
        val result = useCase()
        assertTrue(result is Result.Success)
        assertTrue((result as Result.Success).data.isEmpty())
    }

    @Test
    fun `returns Error on HttpException`() = runTest {
        val response = Response.error<List<Appointment>>(500, "".toResponseBody())
        coEvery { repository.getMyAppointments(null) } throws HttpException(response)
        val result = useCase()
        assertTrue(result is Result.Error)
        assertEquals("HTTP_500", (result as Result.Error).code)
    }

    @Test
    fun `returns NETWORK_ERROR on IOException`() = runTest {
        coEvery { repository.getMyAppointments(null) } throws IOException()
        val result = useCase()
        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }
}
