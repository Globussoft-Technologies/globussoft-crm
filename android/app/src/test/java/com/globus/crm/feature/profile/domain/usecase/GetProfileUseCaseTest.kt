package com.globus.crm.feature.profile.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.profile.domain.model.Profile
import com.globus.crm.feature.profile.domain.repository.ProfileRepository
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

class GetProfileUseCaseTest {

    private lateinit var repository: ProfileRepository
    private lateinit var useCase: GetProfileUseCase

    private val fakeProfile = Profile(
        patientId = 608,
        name = "Priya Sharma",
        phone = null,
        email = "priya@example.com",
        dob = "1990-05-15",
        gender = "female",
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = GetProfileUseCase(repository)
    }

    @Test
    fun `returns Success with profile when API call succeeds`() = runTest {
        coEvery { repository.getProfile() } returns fakeProfile

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(fakeProfile, (result as Result.Success).data)
    }

    @Test
    fun `returns HTTP error code when API throws HttpException`() = runTest {
        val response = Response.error<Profile>(401, "".toResponseBody())
        coEvery { repository.getProfile() } throws HttpException(response)

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("HTTP_401", (result as Result.Error).code)
        assertEquals(401, result.httpStatus)
    }

    @Test
    fun `returns NETWORK_ERROR on IOException`() = runTest {
        coEvery { repository.getProfile() } throws IOException()

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }
}
