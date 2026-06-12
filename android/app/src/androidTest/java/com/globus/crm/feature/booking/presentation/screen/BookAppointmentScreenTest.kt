package com.globus.crm.feature.booking.presentation.screen

import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasProgressBarRangeInfo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.globus.crm.core.theme.WellnessTheme
import com.globus.crm.feature.booking.domain.model.Product
import com.globus.crm.feature.booking.presentation.state.BookAppointmentUiEvent
import com.globus.crm.feature.booking.presentation.state.BookAppointmentUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BookAppointmentScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    private val fakeProduct = Product(
        id = 1,
        name = "Consultation",
        description = null,
        price = 500.0,
        discountedPrice = null,
        imageUrl = null,
        categoryName = "General",
    )

    @Test
    fun loading_state_shows_indeterminate_progress() {
        composeTestRule.setContent {
            WellnessTheme {
                BookAppointmentScreen(
                    state = BookAppointmentUiState(isLoading = true),
                    onEvent = {},
                )
            }
        }
        composeTestRule
            .onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate))
            .assertExists()
    }

    @Test
    fun error_state_with_no_products_shows_error_and_retry() {
        composeTestRule.setContent {
            WellnessTheme {
                BookAppointmentScreen(
                    state = BookAppointmentUiState(
                        isLoading = false,
                        error = "Service unavailable",
                        products = emptyList(),
                    ),
                    onEvent = {},
                )
            }
        }
        composeTestRule.onNodeWithText("Service unavailable").assertIsDisplayed()
        composeTestRule.onNodeWithText("Retry").assertIsDisplayed()
    }

    @Test
    fun step1_empty_products_shows_no_services_available() {
        composeTestRule.setContent {
            WellnessTheme {
                BookAppointmentScreen(
                    state = BookAppointmentUiState(
                        isLoading = false,
                        error = null,
                        products = emptyList(),
                    ),
                    onEvent = {},
                )
            }
        }
        composeTestRule.onNodeWithText("No services available").assertIsDisplayed()
    }

    @Test
    fun step1_shows_product_names() {
        composeTestRule.setContent {
            WellnessTheme {
                BookAppointmentScreen(
                    state = BookAppointmentUiState(
                        isLoading = false,
                        products = listOf(fakeProduct),
                    ),
                    onEvent = {},
                )
            }
        }
        composeTestRule.onNodeWithText("Consultation").assertIsDisplayed()
        composeTestRule.onNodeWithText("General").assertIsDisplayed()
    }

    @Test
    fun step1_continue_button_disabled_without_selection() {
        composeTestRule.setContent {
            WellnessTheme {
                BookAppointmentScreen(
                    state = BookAppointmentUiState(
                        isLoading = false,
                        products = listOf(fakeProduct),
                        selectedProduct = null,
                    ),
                    onEvent = {},
                )
            }
        }
        composeTestRule.onNodeWithText("Continue").assertIsNotEnabled()
    }

    @Test
    fun step1_product_click_fires_SelectProduct_event() {
        val events = mutableListOf<BookAppointmentUiEvent>()
        composeTestRule.setContent {
            WellnessTheme {
                BookAppointmentScreen(
                    state = BookAppointmentUiState(
                        isLoading = false,
                        products = listOf(fakeProduct),
                    ),
                    onEvent = { events += it },
                )
            }
        }
        composeTestRule.onNodeWithText("Consultation").performClick()
        assertTrue(events.isNotEmpty())
        assertEquals(BookAppointmentUiEvent.SelectProduct(fakeProduct), events.first())
    }

    @Test
    fun step3_shows_booking_summary_with_service_name() {
        composeTestRule.setContent {
            WellnessTheme {
                BookAppointmentScreen(
                    state = BookAppointmentUiState(
                        isLoading = false,
                        step = 3,
                        selectedProduct = fakeProduct,
                        selectedDate = 1_748_822_400_000L,
                        selectedTime = "10:00",
                    ),
                    onEvent = {},
                )
            }
        }
        composeTestRule.onNodeWithText("Consultation").assertIsDisplayed()
        composeTestRule.onNodeWithText("10:00").assertIsDisplayed()
        composeTestRule.onNodeWithText("Book Appointment").assertIsDisplayed()
    }
}
