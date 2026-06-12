package com.globus.crm.feature.membership.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.membership.domain.model.Membership
import com.globus.crm.feature.membership.domain.repository.MembershipRepository
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

class GetMyMembershipsUseCaseTest {

    private lateinit var repository: MembershipRepository
    private lateinit var useCase: GetMyMembershipsUseCase

    private val fakeMembership = Membership(
        id = 1,
        planId = 10,
        planName = "Gold Plan",
        planDurationDays = 365,
        startDate = "2026-01-01",
        endDate = "2026-12-31",
        status = "active",
        balance = emptyList(),
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = GetMyMembershipsUseCase(repository)
    }

    @Test
    fun `returns Success with membership list when API call succeeds`() = runTest {
        coEvery { repository.getMyMemberships() } returns listOf(fakeMembership)

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(listOf(fakeMembership), (result as Result.Success).data)
    }

    @Test
    fun `returns HTTP error code when API throws HttpException`() = runTest {
        val response = Response.error<List<Membership>>(403, "".toResponseBody())
        coEvery { repository.getMyMemberships() } throws HttpException(response)

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("HTTP_403", (result as Result.Error).code)
        assertEquals(403, result.httpStatus)
    }

    @Test
    fun `returns cached memberships on IOException when cache is non-empty`() = runTest {
        coEvery { repository.getMyMemberships() } throws IOException()
        coEvery { repository.getCachedMemberships() } returns listOf(fakeMembership)

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(listOf(fakeMembership), (result as Result.Success).data)
    }

    @Test
    fun `returns NETWORK_ERROR on IOException when cache is empty`() = runTest {
        coEvery { repository.getMyMemberships() } throws IOException()
        coEvery { repository.getCachedMemberships() } returns emptyList()

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }
}
