package com.globus.crm.feature.health.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.model.TreatmentPlan
import com.globus.crm.feature.health.domain.repository.TreatmentPlanRepository
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

class GetTreatmentPlansUseCaseTest {

    private lateinit var repository: TreatmentPlanRepository
    private lateinit var useCase: GetTreatmentPlansUseCase

    private val fakePlan = TreatmentPlan(
        id = 1,
        name = "Dental Care Plan",
        totalSessions = 6,
        completedSessions = 2,
        startedAt = "2026-01-15",
        nextDueAt = "2026-07-01",
        status = "active",
        totalPrice = 12000.0,
        serviceName = "Dental Cleaning",
        serviceCategory = "Dental",
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = GetTreatmentPlansUseCase(repository)
    }

    @Test
    fun `returns Success with plan list when API call succeeds`() = runTest {
        coEvery { repository.getTreatmentPlans() } returns listOf(fakePlan)

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(listOf(fakePlan), (result as Result.Success).data)
    }

    @Test
    fun `returns HTTP error when API throws HttpException`() = runTest {
        val response = Response.error<List<TreatmentPlan>>(403, "".toResponseBody())
        coEvery { repository.getTreatmentPlans() } throws HttpException(response)

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("HTTP_403", (result as Result.Error).code)
        assertEquals(403, result.httpStatus)
    }

    @Test
    fun `returns NETWORK_ERROR when IOException thrown`() = runTest {
        coEvery { repository.getTreatmentPlans() } throws IOException()

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }

    @Test
    fun `returns NO_PATIENT_ID error when patientId is not cached`() = runTest {
        coEvery { repository.getTreatmentPlans() } throws IllegalStateException("patientId not cached")

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("NO_PATIENT_ID", (result as Result.Error).code)
    }
}
