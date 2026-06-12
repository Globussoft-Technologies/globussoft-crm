package com.globus.crm.feature.auth.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.model.TenantBranding
import com.globus.crm.feature.auth.domain.repository.AuthRepository
import io.mockk.coEvery
import io.mockk.coVerify
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

class GetTenantBrandingUseCaseTest {

    private lateinit var repository: AuthRepository
    private lateinit var useCase: GetTenantBrandingUseCase

    private val fakeBranding = TenantBranding(
        id = 1,
        slug = "demo-clinic",
        name = "Demo Clinic",
        brandColor = "#265855",
        logoUrl = null,
        tagline = "Care you can trust",
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = GetTenantBrandingUseCase(repository)
    }

    @Test
    fun `returns Success with branding when API call succeeds`() = runTest {
        coEvery { repository.getTenantBranding("demo-clinic") } returns fakeBranding

        val result = useCase("demo-clinic")

        assertTrue(result is Result.Success)
        assertEquals(fakeBranding, (result as Result.Success).data)
        coVerify(exactly = 1) { repository.getTenantBranding("demo-clinic") }
    }

    @Test
    fun `returns Error with HTTP code when API returns HTTP error`() = runTest {
        val response = Response.error<TenantBranding>(404, "".toResponseBody())
        coEvery { repository.getTenantBranding(any()) } throws HttpException(response)

        val result = useCase("unknown-slug")

        assertTrue(result is Result.Error)
        assertEquals("HTTP_404", (result as Result.Error).code)
        assertEquals(404, result.httpStatus)
    }

    @Test
    fun `returns NETWORK_ERROR when IOException thrown`() = runTest {
        coEvery { repository.getTenantBranding(any()) } throws IOException("No network")

        val result = useCase("demo-clinic")

        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }
}
