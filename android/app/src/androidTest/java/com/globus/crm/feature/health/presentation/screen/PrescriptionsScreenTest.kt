package com.globus.crm.feature.health.presentation.screen

import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasProgressBarRangeInfo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.globus.crm.core.theme.WellnessTheme
import com.globus.crm.feature.health.domain.model.Prescription
import com.globus.crm.feature.health.presentation.state.PrescriptionsUiEvent
import com.globus.crm.feature.health.presentation.state.PrescriptionsUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrescriptionsScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    private val fakePrescription = Prescription(
        id = 1,
        visitId = 10,
        visitDate = "2026-05-01",
        doctorName = "Dr. Smith",
        serviceName = "Consultation",
        drugs = emptyList(),
    )

    @Test
    fun loading_state_shows_progress() {
        composeTestRule.setContent {
            WellnessTheme {
                PrescriptionsScreen(
                    state = PrescriptionsUiState(isLoading = true),
                    onEvent = {},
                )
            }
        }
        composeTestRule
            .onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate))
            .assertExists()
    }

    @Test
    fun error_state_shows_error_and_retry() {
        composeTestRule.setContent {
            WellnessTheme {
                PrescriptionsScreen(
                    state = PrescriptionsUiState(
                        isLoading = false,
                        error = "Network error",
                    ),
                    onEvent = {},
                )
            }
        }
        composeTestRule.onNodeWithText("Network error").assertIsDisplayed()
        composeTestRule.onNodeWithText("Retry").assertIsDisplayed()
    }

    @Test
    fun empty_state_shows_no_prescriptions_text() {
        composeTestRule.setContent {
            WellnessTheme {
                PrescriptionsScreen(
                    state = PrescriptionsUiState(
                        isLoading = false,
                        prescriptions = emptyList(),
                    ),
                    onEvent = {},
                )
            }
        }
        composeTestRule.onNodeWithText("No prescriptions found").assertIsDisplayed()
    }

    @Test
    fun list_state_shows_prescription_doctor_name() {
        composeTestRule.setContent {
            WellnessTheme {
                PrescriptionsScreen(
                    state = PrescriptionsUiState(
                        isLoading = false,
                        prescriptions = listOf(fakePrescription),
                    ),
                    onEvent = {},
                )
            }
        }
        composeTestRule.onNodeWithText("Dr. Smith").assertIsDisplayed()
        composeTestRule.onNodeWithText("Consultation").assertIsDisplayed()
    }

    @Test
    fun tap_prescription_fires_ViewPdf_event() {
        val events = mutableListOf<PrescriptionsUiEvent>()
        composeTestRule.setContent {
            WellnessTheme {
                PrescriptionsScreen(
                    state = PrescriptionsUiState(
                        isLoading = false,
                        prescriptions = listOf(fakePrescription),
                    ),
                    onEvent = { events += it },
                )
            }
        }
        composeTestRule.onNodeWithText("Consultation").performClick()
        assertTrue(events.isNotEmpty())
        assertEquals(PrescriptionsUiEvent.ViewPdf(prescriptionId = 1), events.first())
    }
}
