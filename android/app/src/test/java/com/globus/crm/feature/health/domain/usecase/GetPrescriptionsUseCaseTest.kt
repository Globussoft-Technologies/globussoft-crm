package com.globus.crm.feature.health.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.model.Drug
import com.globus.crm.feature.health.domain.model.Prescription
import com.globus.crm.feature.health.domain.repository.PrescriptionRepository
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

class GetPrescriptionsUseCaseTest {

    private lateinit var repository: PrescriptionRepository
    private lateinit var useCase: GetPrescriptionsUseCase

    private val fakePrescription = Prescription(
        id = 1,
        visitId = 10,
        visitDate = "2026-05-01",
        doctorName = "Dr. Patel",
        serviceName = "Consultation",
        drugs = listOf(Drug("Amoxicillin", "500mg", "3x/day", "7 days", null)),
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = GetPrescriptionsUseCase(repository)
    }

    @Test
    fun `returns Success with prescription list when API call succeeds`() = runTest {
        coEvery { repository.getPrescriptions() } returns listOf(fakePrescription)

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(listOf(fakePrescription), (result as Result.Success).data)
    }

    @Test
    fun `returns HTTP error code when API throws HttpException`() = runTest {
        val response = Response.error<List<Prescription>>(500, "".toResponseBody())
        coEvery { repository.getPrescriptions() } throws HttpException(response)

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("HTTP_500", (result as Result.Error).code)
        assertEquals(500, result.httpStatus)
    }

    @Test
    fun `returns cached prescriptions on IOException when cache is non-empty`() = runTest {
        coEvery { repository.getPrescriptions() } throws IOException()
        coEvery { repository.getCachedPrescriptions() } returns listOf(fakePrescription)

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(listOf(fakePrescription), (result as Result.Success).data)
    }

    @Test
    fun `returns NETWORK_ERROR on IOException when cache is empty`() = runTest {
        coEvery { repository.getPrescriptions() } throws IOException()
        coEvery { repository.getCachedPrescriptions() } returns emptyList()

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }
}
