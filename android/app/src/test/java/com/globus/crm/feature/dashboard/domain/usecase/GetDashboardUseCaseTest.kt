package com.globus.crm.feature.dashboard.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.dashboard.domain.model.Dashboard
import com.globus.crm.feature.dashboard.domain.repository.DashboardRepository
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException

class GetDashboardUseCaseTest {

    private lateinit var repository: DashboardRepository
    private lateinit var useCase: GetDashboardUseCase

    private val fullDashboard = Dashboard(
        patientName = "Priya",
        nextVisit = null,
        walletBalance = 5000L,
        walletCurrency = "INR",
        activeMembershipCount = 2,
        loyaltyPoints = null,
    )

    private val degradedDashboard = Dashboard(
        patientName = "Priya",
        nextVisit = null,
        walletBalance = null,
        walletCurrency = null,
        activeMembershipCount = 0,
        loyaltyPoints = null,
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = GetDashboardUseCase(repository)
    }

    @Test
    fun `returns Success with full Dashboard on happy path`() = runTest {
        coEvery { repository.getDashboard() } returns fullDashboard

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(fullDashboard, (result as Result.Success).data)
    }

    @Test
    fun `returns Success with degraded Dashboard when wallet and memberships are unavailable`() = runTest {
        coEvery { repository.getDashboard() } returns degradedDashboard

        val result = useCase()

        assertTrue(result is Result.Success)
        val data = (result as Result.Success).data
        assertNull(data.walletBalance)
        assertEquals(0, data.activeMembershipCount)
    }

    @Test
    fun `returns Error with HTTP code on HttpException`() = runTest {
        val response = Response.error<Dashboard>(503, "".toResponseBody())
        coEvery { repository.getDashboard() } throws HttpException(response)

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("HTTP_503", (result as Result.Error).code)
    }

    @Test
    fun `returns NETWORK_ERROR on IOException`() = runTest {
        coEvery { repository.getDashboard() } throws IOException()

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }
}
