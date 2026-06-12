package com.globus.crm.feature.notifications.presentation.viewmodel

import app.cash.turbine.test
import com.globus.crm.feature.notifications.domain.model.Notification
import com.globus.crm.feature.notifications.domain.usecase.GetNotificationsUseCase
import com.globus.crm.feature.notifications.domain.usecase.MarkNotificationReadUseCase
import com.globus.crm.feature.notifications.presentation.state.NotificationsUiEvent
import io.mockk.coJustRun
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NotificationsViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var getNotifications: GetNotificationsUseCase
    private lateinit var markRead: MarkNotificationReadUseCase
    private lateinit var vm: NotificationsViewModel

    private val fakeNotification = Notification(
        id = "n1",
        type = "BOOKING_CONFIRMED",
        title = "Booking",
        body = "Confirmed",
        screen = "appointments",
        entityId = null,
        isRead = false,
        receivedAt = 1000L,
    )

    private val notificationNoScreen = fakeNotification.copy(id = "n2", screen = null)

    @BeforeEach
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        getNotifications = mockk()
        markRead = mockk()
    }

    @AfterEach
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `init collects from flow and populates notifications list`() = runTest {
        every { getNotifications() } returns flowOf(listOf(fakeNotification))

        vm = NotificationsViewModel(getNotifications, markRead)

        assertFalse(vm.uiState.value.isLoading)
        assertEquals(listOf(fakeNotification), vm.uiState.value.notifications)
    }

    @Test
    fun `MarkRead event calls markRead with correct id`() = runTest {
        every { getNotifications() } returns flowOf(emptyList())
        coJustRun { markRead(any()) }
        vm = NotificationsViewModel(getNotifications, markRead)

        vm.onEvent(NotificationsUiEvent.MarkRead("n1"))

        coVerify(exactly = 1) { markRead("n1") }
    }

    @Test
    fun `MarkAllRead event calls markAll`() = runTest {
        every { getNotifications() } returns flowOf(emptyList())
        coJustRun { markRead.markAll() }
        vm = NotificationsViewModel(getNotifications, markRead)

        vm.onEvent(NotificationsUiEvent.MarkAllRead)

        coVerify(exactly = 1) { markRead.markAll() }
    }

    @Test
    fun `TapNotification with screen calls markRead and emits OpenDeepLink nav event`() = runTest {
        every { getNotifications() } returns flowOf(listOf(fakeNotification))
        coJustRun { markRead(any()) }
        vm = NotificationsViewModel(getNotifications, markRead)

        vm.navEvent.test {
            vm.onEvent(NotificationsUiEvent.TapNotification(fakeNotification))
            val event = awaitItem()
            assertEquals(
                NotificationsNavEvent.OpenDeepLink("appointments", null),
                event,
            )
            cancelAndIgnoreRemainingEvents()
        }
        coVerify(exactly = 1) { markRead("n1") }
    }

    @Test
    fun `TapNotification without screen calls markRead but emits no nav event`() = runTest {
        every { getNotifications() } returns flowOf(listOf(notificationNoScreen))
        coJustRun { markRead(any()) }
        vm = NotificationsViewModel(getNotifications, markRead)

        vm.navEvent.test {
            vm.onEvent(NotificationsUiEvent.TapNotification(notificationNoScreen))
            expectNoEvents()
            cancelAndIgnoreRemainingEvents()
        }
        coVerify(exactly = 1) { markRead("n2") }
    }

    @Test
    fun `NavigateBack event emits Back nav event`() = runTest {
        every { getNotifications() } returns flowOf(emptyList())
        vm = NotificationsViewModel(getNotifications, markRead)

        vm.navEvent.test {
            vm.onEvent(NotificationsUiEvent.NavigateBack)
            assertEquals(NotificationsNavEvent.Back, awaitItem())
            cancelAndIgnoreRemainingEvents()
        }
    }
}
