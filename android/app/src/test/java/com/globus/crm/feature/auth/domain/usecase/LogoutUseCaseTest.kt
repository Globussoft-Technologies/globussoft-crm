package com.globus.crm.feature.auth.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.repository.AuthRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.IOException

class LogoutUseCaseTest {

    private lateinit var repository: AuthRepository
    private lateinit var useCase: LogoutUseCase

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = LogoutUseCase(repository)
    }

    @Test
    fun `returns Success(Unit) and calls repository logout`() = runTest {
        coEvery { repository.logout() } returns Unit

        val result = useCase()

        assertTrue(result is Result.Success)
        coVerify(exactly = 1) { repository.logout() }
    }

    @Test
    fun `returns STORAGE_ERROR when IOException thrown during logout`() = runTest {
        coEvery { repository.logout() } throws IOException()

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("STORAGE_ERROR", (result as Result.Error).code)
    }
}
