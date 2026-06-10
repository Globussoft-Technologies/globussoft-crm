package com.globus.crm.feature.health.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.model.ConsentForm
import com.globus.crm.feature.health.domain.repository.ConsentFormRepository
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

class GetConsentFormsUseCaseTest {

    private lateinit var repository: ConsentFormRepository
    private lateinit var useCase: GetConsentFormsUseCase

    private val fakeForm = ConsentForm(
        id = 1,
        templateName = "General Treatment Consent",
        signedAt = "2026-05-10T09:30:00.000Z",
        hasPdfBlob = true,
        serviceName = "Dental Cleaning",
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        useCase = GetConsentFormsUseCase(repository)
    }

    @Test
    fun `returns Success with consent form list when API call succeeds`() = runTest {
        coEvery { repository.getConsentForms() } returns listOf(fakeForm)

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(listOf(fakeForm), (result as Result.Success).data)
    }

    @Test
    fun `returns HTTP error when API throws HttpException`() = runTest {
        val response = Response.error<List<ConsentForm>>(403, "".toResponseBody())
        coEvery { repository.getConsentForms() } throws HttpException(response)

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("HTTP_403", (result as Result.Error).code)
        assertEquals(403, result.httpStatus)
    }

    @Test
    fun `returns NETWORK_ERROR when IOException thrown`() = runTest {
        coEvery { repository.getConsentForms() } throws IOException()

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }

    @Test
    fun `returns NO_PATIENT_ID error when patientId is not cached`() = runTest {
        coEvery { repository.getConsentForms() } throws IllegalStateException("patientId not cached")

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("NO_PATIENT_ID", (result as Result.Error).code)
    }
}
