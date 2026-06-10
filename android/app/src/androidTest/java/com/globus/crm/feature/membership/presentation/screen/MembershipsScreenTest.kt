package com.globus.crm.feature.membership.presentation.screen

import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasProgressBarRangeInfo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.globus.crm.core.theme.WellnessTheme
import com.globus.crm.feature.membership.domain.model.Membership
import com.globus.crm.feature.membership.domain.model.MembershipPlan
import com.globus.crm.feature.membership.presentation.state.MembershipsUiEvent
import com.globus.crm.feature.membership.presentation.state.MembershipsUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MembershipsScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    private val fakeMembership = Membership(
        id = 1,
        planId = 10,
        planName = "Premium Plan",
        planDurationDays = 365,
        startDate = "2026-01-01",
        endDate = "2026-12-31",
        status = "active",
        balance = emptyList(),
    )

    private val fakePlan = MembershipPlan(
        id = 1,
        name = "Health Plan",
        description = "5 sessions included",
        price = 2999.0,
        currency = "INR",
        durationDays = 365,
        entitlements = null,
    )

    @Test
    fun loading_state_shows_progress() {
        composeTestRule.setContent {
            WellnessTheme {
                MembershipsScreen(
                    state = MembershipsUiState(isLoading = true),
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
                MembershipsScreen(
                    state = MembershipsUiState(
                        isLoading = false,
                        error = "Failed to load",
                    ),
                    onEvent = {},
                )
            }
        }
        composeTestRule.onNodeWithText("Failed to load").assertIsDisplayed()
        composeTestRule.onNodeWithText("Retry").assertIsDisplayed()
    }

    @Test
    fun empty_state_shows_no_memberships_text() {
        composeTestRule.setContent {
            WellnessTheme {
                MembershipsScreen(
                    state = MembershipsUiState(
                        isLoading = false,
                        memberships = emptyList(),
                    ),
                    onEvent = {},
                )
            }
        }
        composeTestRule.onNodeWithText("No memberships found").assertIsDisplayed()
    }

    @Test
    fun list_state_shows_plan_name() {
        composeTestRule.setContent {
            WellnessTheme {
                MembershipsScreen(
                    state = MembershipsUiState(
                        isLoading = false,
                        memberships = listOf(fakeMembership),
                    ),
                    onEvent = {},
                )
            }
        }
        composeTestRule.onNodeWithText("Premium Plan").assertIsDisplayed()
    }

    @Test
    fun show_plans_mode_shows_plan_catalog_and_my_memberships_button() {
        val events = mutableListOf<MembershipsUiEvent>()
        composeTestRule.setContent {
            WellnessTheme {
                MembershipsScreen(
                    state = MembershipsUiState(
                        isLoading = false,
                        plans = listOf(fakePlan),
                        showPlans = true,
                    ),
                    onEvent = { events += it },
                )
            }
        }
        composeTestRule.onNodeWithText("Health Plan").assertIsDisplayed()
        composeTestRule.onNodeWithText("5 sessions included").assertIsDisplayed()
        // When showPlans=true the toolbar button reads "My Memberships"
        composeTestRule.onNodeWithText("My Memberships").assertIsDisplayed()
        // Clicking "My Memberships" fires TogglePlans
        composeTestRule.onNodeWithText("My Memberships").performClick()
        assertTrue(events.isNotEmpty())
        assertEquals(MembershipsUiEvent.TogglePlans, events.first())
    }
}
