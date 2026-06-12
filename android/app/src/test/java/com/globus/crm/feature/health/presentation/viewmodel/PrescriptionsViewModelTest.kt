package com.globus.crm.feature.health.presentation.viewmodel

import app.cash.turbine.test
import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.model.PatientPermissions
import com.globus.crm.feature.auth.domain.usecase.GetPatientPermissionsUseCase
import com.globus.crm.feature.health.domain.model.Prescription
import com.globus.crm.feature.health.domain.usecase.GetPrescriptionsUseCase
import com.globus.crm.feature.health.presentation.state.PrescriptionsUiEvent
import io.mockk.coEvery
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
class PrescriptionsViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var getPrescriptionsUseCase: GetPrescriptionsUseCase
    private lateinit var getPermissionsUseCase: GetPatientPermissionsUseCase
    private lateinit var vm: PrescriptionsViewModel

    private val fakePrescription = Prescription(
        id = 1,
        visitId = 10,
        visitDate = "2026-05-01",
        doctorName = "Dr. Test",
        serviceName = null,
        drugs = emptyList(),
    )

    private val permittedPermissions = PatientPermissions(setOf(PatientPermissions.PRESCRIPTIONS_READ))

    @BeforeEach
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        getPrescriptionsUseCase = mockk()
        getPermissionsUseCase = mockk()
        coEvery { getPermissionsUseCase() } returns Result.Success(permittedPermissions)
    }

    @AfterEach
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `init loads prescriptions into success state`() = runTest {
        coEvery { getPrescriptionsUseCase() } returns Result.Success(listOf(fakePrescription))

        vm = PrescriptionsViewModel(getPrescriptionsUseCase, getPermissionsUseCase)

        assertFalse(vm.uiState.value.isLoading)
        assertNull(vm.uiState.value.error)
        assertEquals(listOf(fakePrescription), vm.uiState.value.prescriptions)
    }

    @Test
    fun `init sets error state when getPrescriptionsUseCase returns Error`() = runTest {
        coEvery { getPrescriptionsUseCase() } returns Result.Error("HTTP_401", "Unauthorized", 401)

        vm = PrescriptionsViewModel(getPrescriptionsUseCase, getPermissionsUseCase)

        assertFalse(vm.uiState.value.isLoading)
        assertNotNull(vm.uiState.value.error)
        assertTrue(vm.uiState.value.prescriptions.isEmpty())
    }

    @Test
    fun `Refresh event reloads data with updated result`() = runTest {
        coEvery { getPrescriptionsUseCase() } returns Result.Error("NETWORK_ERROR", "No connection")
        vm = PrescriptionsViewModel(getPrescriptionsUseCase, getPermissionsUseCase)
        assertNotNull(vm.uiState.value.error)

        coEvery { getPrescriptionsUseCase() } returns Result.Success(listOf(fakePrescription))
        vm.onEvent(PrescriptionsUiEvent.Refresh)

        assertFalse(vm.uiState.value.isLoading)
        assertNull(vm.uiState.value.error)
        assertEquals(listOf(fakePrescription), vm.uiState.value.prescriptions)
    }

    @Test
    fun `ViewPdf event emits ToPdf nav event with correct id`() = runTest {
        coEvery { getPrescriptionsUseCase() } returns Result.Success(listOf(fakePrescription))
        vm = PrescriptionsViewModel(getPrescriptionsUseCase, getPermissionsUseCase)

        vm.navEvent.test {
            vm.onEvent(PrescriptionsUiEvent.ViewPdf(prescriptionId = 1))
            assertEquals(PrescriptionsNavEvent.ToPdf(1), awaitItem())
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `NavigateBack event emits Back nav event`() = runTest {
        coEvery { getPrescriptionsUseCase() } returns Result.Success(emptyList())
        vm = PrescriptionsViewModel(getPrescriptionsUseCase, getPermissionsUseCase)

        vm.navEvent.test {
            vm.onEvent(PrescriptionsUiEvent.NavigateBack)
            assertEquals(PrescriptionsNavEvent.Back, awaitItem())
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `sets permissionBlocked when my_prescriptions_read is absent`() = runTest {
        coEvery { getPermissionsUseCase() } returns Result.Success(PatientPermissions.EMPTY)

        vm = PrescriptionsViewModel(getPrescriptionsUseCase, getPermissionsUseCase)

        assertFalse(vm.uiState.value.isLoading)
        assertTrue(vm.uiState.value.permissionBlocked)
        assertTrue(vm.uiState.value.prescriptions.isEmpty())
        assertNull(vm.uiState.value.error)
    }
}
