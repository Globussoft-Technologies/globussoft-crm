package com.globus.crm.feature.auth.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.repository.AuthRepository
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.IOException

class CheckAuthStatusUseCaseTest {

    private lateinit var repository: AuthRepository
    private lateinit var useCase: CheckAuthStatusUseCase

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = CheckAuthStatusUseCase(repository)
    }

    @Test
    fun `returns Success(true) when token exists`() = runTest {
        coEvery { repository.hasValidToken() } returns true

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(true, (result as Result.Success).data)
    }

    @Test
    fun `returns Success(false) when no token`() = runTest {
        coEvery { repository.hasValidToken() } returns false

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(false, (result as Result.Success).data)
    }

    @Test
    fun `returns STORAGE_ERROR when IOException thrown`() = runTest {
        coEvery { repository.hasValidToken() } throws IOException()

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("STORAGE_ERROR", (result as Result.Error).code)
    }
}
