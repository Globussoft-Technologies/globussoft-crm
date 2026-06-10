package com.globus.crm.feature.loyalty.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.loyalty.domain.model.LoyaltyData
import com.globus.crm.feature.loyalty.domain.model.LoyaltyTransaction
import com.globus.crm.feature.loyalty.domain.repository.LoyaltyRepository
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

class GetLoyaltyUseCaseTest {

    private lateinit var repository: LoyaltyRepository
    private lateinit var useCase: GetLoyaltyUseCase

    private val fakeLoyalty = LoyaltyData(
        balance = 1500,
        earnedThisMonth = 300,
        transactions = listOf(
            LoyaltyTransaction(
                id = 1,
                type = "earned",
                points = 300,
                reason = "Post-visit reward",
                createdAt = "2026-05-20T10:00:00.000Z",
            ),
        ),
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = GetLoyaltyUseCase(repository)
    }

    @Test
    fun `returns Success with loyalty data when API call succeeds`() = runTest {
        coEvery { repository.getLoyalty() } returns fakeLoyalty

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(fakeLoyalty, (result as Result.Success).data)
    }

    @Test
    fun `returns HTTP error when API throws HttpException`() = runTest {
        val response = Response.error<LoyaltyData>(500, "".toResponseBody())
        coEvery { repository.getLoyalty() } throws HttpException(response)

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("HTTP_500", (result as Result.Error).code)
        assertEquals(500, result.httpStatus)
    }

    @Test
    fun `returns NETWORK_ERROR when IOException thrown`() = runTest {
        coEvery { repository.getLoyalty() } throws IOException()

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }

    @Test
    fun `returns NO_PATIENT_ID error when patientId is not cached`() = runTest {
        coEvery { repository.getLoyalty() } throws IllegalStateException("patientId not cached")

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("NO_PATIENT_ID", (result as Result.Error).code)
    }
}
