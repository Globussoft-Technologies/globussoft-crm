package com.globus.crm.feature.wallet.domain.usecase

import com.globus.crm.core.storage.EncryptedPrefsManager
import com.globus.crm.core.util.Result
import com.globus.crm.feature.wallet.domain.model.WalletSummary
import com.globus.crm.feature.wallet.domain.repository.WalletRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
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

class GetMyTransactionsUseCaseTest {

    private lateinit var repository: WalletRepository
    private lateinit var encryptedPrefs: EncryptedPrefsManager
    private lateinit var useCase: GetMyTransactionsUseCase

    private val fakeWalletSummary = WalletSummary(
        balance = 2000.0,
        currency = "INR",
        transactions = emptyList(),
    )

    @BeforeEach
    fun setUp() {
        repository = mockk()
        encryptedPrefs = mockk()
        useCase = GetMyTransactionsUseCase(repository, encryptedPrefs)
    }

    @Test
    fun `calls getWalletSummary with patientId when patientId is cached`() = runTest {
        every { encryptedPrefs.getPatientId() } returns 608
        coEvery { repository.getWalletSummary(608) } returns fakeWalletSummary

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(fakeWalletSummary, (result as Result.Success).data)
        coVerify(exactly = 1) { repository.getWalletSummary(608) }
        coVerify(exactly = 0) { repository.getMyTransactions() }
    }

    @Test
    fun `calls getMyTransactions when no patientId is cached`() = runTest {
        every { encryptedPrefs.getPatientId() } returns null
        coEvery { repository.getMyTransactions() } returns fakeWalletSummary

        val result = useCase()

        assertTrue(result is Result.Success)
        assertEquals(fakeWalletSummary, (result as Result.Success).data)
        coVerify(exactly = 1) { repository.getMyTransactions() }
        coVerify(exactly = 0) { repository.getWalletSummary(any()) }
    }

    @Test
    fun `returns HTTP error code when API throws HttpException`() = runTest {
        every { encryptedPrefs.getPatientId() } returns 608
        val response = Response.error<WalletSummary>(401, "".toResponseBody())
        coEvery { repository.getWalletSummary(any()) } throws HttpException(response)

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("HTTP_401", (result as Result.Error).code)
        assertEquals(401, result.httpStatus)
    }

    @Test
    fun `returns NETWORK_ERROR on IOException`() = runTest {
        every { encryptedPrefs.getPatientId() } returns 608
        coEvery { repository.getWalletSummary(any()) } throws IOException()

        val result = useCase()

        assertTrue(result is Result.Error)
        assertEquals("NETWORK_ERROR", (result as Result.Error).code)
    }
}
