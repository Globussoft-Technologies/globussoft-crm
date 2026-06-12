package com.globus.crm.feature.dashboard.presentation.viewmodel

import app.cash.turbine.test
import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.usecase.LogoutUseCase
import com.globus.crm.feature.dashboard.domain.model.Dashboard
import com.globus.crm.feature.dashboard.domain.usecase.GetDashboardUseCase
import com.globus.crm.feature.dashboard.presentation.state.DashboardUiEvent
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DashboardViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var getDashboardUseCase: GetDashboardUseCase
    private lateinit var logoutUseCase: LogoutUseCase
    private lateinit var vm: DashboardViewModel

    private val fakeDashboard = Dashboard(
        patientName = "Test Patient",
        nextVisit = null,
        walletBalance = 1000L,
        walletCurrency = "INR",
        activeMembershipCount = 1,
        loyaltyPoints = null,
    )

    @BeforeEach
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        getDashboardUseCase = mockk()
        logoutUseCase = mockk()
    }

    @AfterEach
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `init populates success state when getDashboardUseCase returns Success`() = runTest {
        coEvery { getDashboardUseCase() } returns Result.Success(fakeDashboard)

        vm = DashboardViewModel(getDashboardUseCase, logoutUseCase)

        assertFalse(vm.uiState.value.isLoading)
        assertNull(vm.uiState.value.error)
        assertEquals(fakeDashboard, vm.uiState.value.dashboard)
    }

    @Test
    fun `init sets error state when getDashboardUseCase returns Error`() = runTest {
        coEvery { getDashboardUseCase() } returns Result.Error("HTTP_503", "Service Unavailable", 503)

        vm = DashboardViewModel(getDashboardUseCase, logoutUseCase)

        assertFalse(vm.uiState.value.isLoading)
        assertNotNull(vm.uiState.value.error)
        assertNull(vm.uiState.value.dashboard)
    }

    @Test
    fun `Refresh event reloads dashboard with updated result`() = runTest {
        coEvery { getDashboardUseCase() } returns Result.Success(fakeDashboard)
        vm = DashboardViewModel(getDashboardUseCase, logoutUseCase)
        assertEquals(fakeDashboard, vm.uiState.value.dashboard)

        coEvery { getDashboardUseCase() } returns Result.Error("HTTP_500", "Server error", 500)
        vm.onEvent(DashboardUiEvent.Refresh)

        assertFalse(vm.uiState.value.isLoading)
        assertNotNull(vm.uiState.value.error)
        assertNull(vm.uiState.value.dashboard)
    }

    @Test
    fun `NavigateToAppointments emits ToAppointments nav event`() = runTest {
        coEvery { getDashboardUseCase() } returns Result.Success(fakeDashboard)
        vm = DashboardViewModel(getDashboardUseCase, logoutUseCase)

        vm.navigationEvent.test {
            vm.onEvent(DashboardUiEvent.NavigateToAppointments)
            assertEquals(DashboardNavEvent.ToAppointments, awaitItem())
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `Logout calls logoutUseCase and emits ToLogin nav event`() = runTest {
        coEvery { getDashboardUseCase() } returns Result.Success(fakeDashboard)
        coEvery { logoutUseCase() } returns Result.Success(Unit)
        vm = DashboardViewModel(getDashboardUseCase, logoutUseCase)

        vm.navigationEvent.test {
            vm.onEvent(DashboardUiEvent.Logout)
            assertEquals(DashboardNavEvent.ToLogin, awaitItem())
            cancelAndIgnoreRemainingEvents()
        }
        coVerify(exactly = 1) { logoutUseCase() }
    }
}
