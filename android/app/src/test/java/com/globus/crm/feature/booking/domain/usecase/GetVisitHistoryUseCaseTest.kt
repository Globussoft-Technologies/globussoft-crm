package com.globus.crm.feature.booking.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.booking.domain.model.Visit
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

class GetVisitHistoryUseCaseTest {

    private lateinit var repository: AppointmentRepository
    private lateinit var useCase: GetVisitHistoryUseCase

    private val fakeVisit = Visit(
        id = 1,
        visitDate = "2026-05-01T09:00:00Z",
        status = "checked-out",
        serviceName = "Facial",
        doctorName = "Dr. Priya",
        locationName = null,
        bookingType = "in-person",
        videoCallUrl = null,
        amountCharged = 1500.0,
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = GetVisitHistoryUseCase(repository)
    }

    @Test
    fun `returns Success with visit list from network`() = runTest {
        coEvery { repository.getVisitHistory(false) } returns listOf(fakeVisit)
        val result = useCase()
        assertTrue(result is Result.Success)
        assertEquals(listOf(fakeVisit), (result as Result.Success).data)
    }

    @Test
    fun `falls back to cache on IOException`() = runTest {
        coEvery { repository.getVisitHistory(false) } throws IOException()
        coEvery { repository.getCachedVisits() } returns listOf(fakeVisit)
        val result = useCase()
        assertTrue(result is Result.Success)
        assertEquals(listOf(fakeVisit), (result as Result.Success).data)
    }

    @Test
    fun `returns NETWORK_ERROR when cache also empty`() = runTest {
        coEvery { repository.getVisitHistory(false) } throws IOException()
        coEvery { repository.getCachedVisits() } returns emptyList()
        val result = useCase()
        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }

    @Test
    fun `returns Error on HttpException`() = runTest {
        val response = Response.error<List<Visit>>(401, "".toResponseBody())
        coEvery { repository.getVisitHistory(false) } throws HttpException(response)
        val result = useCase()
        assertTrue(result is Result.Error)
        assertEquals("HTTP_401", (result as Result.Error).code)
    }
}
