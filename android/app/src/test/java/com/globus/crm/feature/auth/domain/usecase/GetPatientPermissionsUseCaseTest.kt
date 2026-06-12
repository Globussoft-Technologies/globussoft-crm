package com.globus.crm.feature.auth.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.model.PatientPermissions
import com.globus.crm.feature.auth.domain.repository.AuthRepository
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException

class GetPatientPermissionsUseCaseTest {

    private lateinit var repository: AuthRepository
    private lateinit var useCase: GetPatientPermissionsUseCase

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = GetPatientPermissionsUseCase(repository)
    }

    @Test
    fun `returns Success with permissions on 200`() = runTest {
        val perms = PatientPermissions(setOf("my_prescriptions.read", "products.read"))
        coEvery { repository.getPatientPermissions() } returns perms

        val result = useCase()

        assertTrue(result is Result.Success)
        assertTrue((result as Result.Success).data.has(PatientPermissions.PRESCRIPTIONS_READ))
        assertTrue(result.data.has(PatientPermissions.PRODUCTS_READ))
    }

    @Test
    fun `returns Success with empty permissions when set is empty`() = runTest {
        coEvery { repository.getPatientPermissions() } returns PatientPermissions.EMPTY

        val result = useCase()

        assertTrue(result is Result.Success)
        assertFalse((result as Result.Success).data.has(PatientPermissions.PRESCRIPTIONS_READ))
    }

    @Test
    fun `returns UNAUTHORIZED on 401`() = runTest {
        val response = Response.error<Unit>(401, "".toResponseBody())
        coEvery { repository.getPatientPermissions() } throws HttpException(response)

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("UNAUTHORIZED", (result as Result.Error).code)
    }

    @Test
    fun `returns HTTP error code on non-401 HTTP error`() = runTest {
        val response = Response.error<Unit>(500, "".toResponseBody())
        coEvery { repository.getPatientPermissions() } throws HttpException(response)

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("HTTP_500", (result as Result.Error).code)
    }

    @Test
    fun `returns empty permissions on network error so app degrades gracefully`() = runTest {
        coEvery { repository.getPatientPermissions() } throws IOException()

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(PatientPermissions.EMPTY, (result as Result.Success).data)
    }
}
