package com.globus.crm.feature.auth.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.model.Patient
import com.globus.crm.feature.auth.domain.repository.AuthRepository
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

class LoginUseCaseTest {

    private lateinit var repository: AuthRepository
    private lateinit var useCase: LoginUseCase

    private val fakePatient = Patient(userId = 1, name = "Priya", email = "priya@example.com")

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = LoginUseCase(repository)
    }

    @Test
    fun `returns Success with patient on successful login`() = runTest {
        coEvery { repository.login("priya@example.com", "secret123") } returns fakePatient

        val result = useCase("priya@example.com", "secret123")

        assertTrue(result is Result.Success)
        assertEquals(fakePatient, (result as Result.Success).data)
    }

    @Test
    fun `returns INVALID_CREDENTIALS on 401`() = runTest {
        val response = Response.error<Patient>(401, "".toResponseBody())
        coEvery { repository.login(any(), any()) } throws HttpException(response)

        val result = useCase("priya@example.com", "wrongpassword")

        assertTrue(result is Result.Error)
        assertEquals("INVALID_CREDENTIALS", (result as Result.Error).code)
    }

    @Test
    fun `returns INVALID_INPUT on 400`() = runTest {
        val response = Response.error<Patient>(400, "".toResponseBody())
        coEvery { repository.login(any(), any()) } throws HttpException(response)

        val result = useCase("", "")

        assertTrue(result is Result.Error)
        assertEquals("INVALID_INPUT", (result as Result.Error).code)
    }

    @Test
    fun `returns NETWORK_ERROR on IOException`() = runTest {
        coEvery { repository.login(any(), any()) } throws IOException()

        val result = useCase("priya@example.com", "secret123")

        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }
}
