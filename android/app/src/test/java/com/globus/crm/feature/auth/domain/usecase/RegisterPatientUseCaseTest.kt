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

class RegisterPatientUseCaseTest {

    private lateinit var repository: AuthRepository
    private lateinit var useCase: RegisterPatientUseCase

    private val fakePatient = Patient(userId = 2, name = "Rahul", email = "rahul@example.com")

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = RegisterPatientUseCase(repository)
    }

    @Test
    fun `returns Success with patient when registration succeeds`() = runTest {
        coEvery { repository.register("rahul@example.com", "pass1234", "Rahul") } returns fakePatient

        val result = useCase("rahul@example.com", "pass1234", "Rahul")

        assertTrue(result is Result.Success)
        assertEquals(fakePatient, (result as Result.Success).data)
    }

    @Test
    fun `returns INVALID_INPUT on 400 with generic message`() = runTest {
        val response = Response.error<Patient>(400, "".toResponseBody())
        coEvery { repository.register(any(), any(), any()) } throws HttpException(response)

        val result = useCase("rahul@example.com", "pass1234", "Rahul")

        assertTrue(result is Result.Error)
        assertEquals("INVALID_INPUT", (result as Result.Error).code)
    }

    @Test
    fun `returns HTTP_409 on 409 conflict`() = runTest {
        val response = Response.error<Patient>(409, "".toResponseBody())
        coEvery { repository.register(any(), any(), any()) } throws HttpException(response)

        val result = useCase("rahul@example.com", "pass1234", "Rahul")

        assertTrue(result is Result.Error)
        assertEquals("HTTP_409", (result as Result.Error).code)
    }

    @Test
    fun `returns NETWORK_ERROR on IOException`() = runTest {
        coEvery { repository.register(any(), any(), any()) } throws IOException()

        val result = useCase("rahul@example.com", "pass1234", "Rahul")

        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }
}
