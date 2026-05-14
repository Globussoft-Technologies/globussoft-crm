package com.globussoft.wellness.feature.patients.presentation.detail.tabs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.List
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessDropdown
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.core.domain.model.TreatmentPlan
import com.globussoft.wellness.feature.patients.presentation.detail.PatientDetailEvent
import com.globussoft.wellness.feature.patients.presentation.detail.PatientDetailUiState

/**
 * Tab 3 — Treatment Plans.
 *
 * Create-plan form at top, then list of existing plans with progress bars.
 */
@Composable
fun TreatmentPlansTab(
    state: PatientDetailUiState,
    onEvent: (PatientDetailEvent) -> Unit,
) {
    var planName      by remember { mutableStateOf("") }
    var totalSessions by remember { mutableStateOf("") }
    var totalPrice    by remember { mutableStateOf("") }
    var selectedSvcId by remember { mutableStateOf("") }
    var nameError     by remember { mutableStateOf<String?>(null) }
    var sessionsError by remember { mutableStateOf<String?>(null) }

    val serviceOptions = listOf("" to "No service") +
        state.services.map { it.id to it.name }

    LazyColumn(
        contentPadding      = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        modifier            = Modifier.fillMaxSize(),
    ) {
        item {
            WellnessCard(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier            = Modifier.padding(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                ) {
                    Text(
                        text       = "New Treatment Plan",
                        style      = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color      = WellnessPrimary,
                    )

                    WellnessTextField(
                        value         = planName,
                        onValueChange = { planName = it; nameError = null },
                        label         = "Plan Name *",
                        placeholder   = "6-session Hydrafacial course",
                        isError       = nameError != null,
                        errorMessage  = nameError,
                        imeAction     = ImeAction.Next,
                    )

                    Row(
                        modifier              = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    ) {
                        WellnessTextField(
                            value         = totalSessions,
                            onValueChange = { totalSessions = it; sessionsError = null },
                            label         = "Sessions *",
                            placeholder   = "6",
                            keyboardType  = KeyboardType.Number,
                            isError       = sessionsError != null,
                            errorMessage  = sessionsError,
                            imeAction     = ImeAction.Next,
                            modifier      = Modifier.weight(1f),
                        )
                        WellnessTextField(
                            value         = totalPrice,
                            onValueChange = { totalPrice = it },
                            label         = "Price (optional)",
                            placeholder   = "15000",
                            keyboardType  = KeyboardType.Decimal,
                            imeAction     = ImeAction.Next,
                            modifier      = Modifier.weight(1f),
                        )
                    }

                    WellnessDropdown(
                        value         = selectedSvcId,
                        onValueChange = { selectedSvcId = it },
                        label         = "Linked Service",
                        options       = serviceOptions,
                    )

                    if (state.createPlanError != null) {
                        Text(
                            text  = state.createPlanError,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }

                    WellnessButton(
                        text      = "Create Plan",
                        isLoading = state.isCreatingPlan,
                        onClick   = {
                            var valid = true
                            if (planName.isBlank()) { nameError = "Name is required"; valid = false }
                            val sessions = totalSessions.toIntOrNull()
                            if (sessions == null || sessions <= 0) {
                                sessionsError = "Enter a valid number of sessions"; valid = false
                            }
                            if (!valid) return@WellnessButton
                            onEvent(
                                PatientDetailEvent.CreateTreatmentPlan(
                                    name          = planName,
                                    totalSessions = sessions!!,
                                    serviceId     = selectedSvcId,
                                    totalPrice    = totalPrice,
                                )
                            )
                            planName = ""; totalSessions = ""; totalPrice = ""; selectedSvcId = ""
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

        item {
            HorizontalDivider(
                modifier = Modifier.padding(vertical = Dimens.SpacingSm),
                color    = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
            )
            Text(
                text       = "Active Plans",
                style      = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color      = WellnessTextSecondary,
                modifier   = Modifier.padding(bottom = Dimens.SpacingSm),
            )
        }

        if (state.treatmentPlans.isEmpty()) {
            item {
                EmptyState(
                    message  = "No treatment plans on file.\nCreate one using the form above.",
                    icon     = Icons.Default.List,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        } else {
            items(state.treatmentPlans) { plan ->
                TreatmentPlanCard(plan)
            }
        }
    }
}

@Composable
private fun TreatmentPlanCard(plan: TreatmentPlan) {
    val progress = if (plan.totalSessions > 0)
        plan.completedSessions.toFloat() / plan.totalSessions.toFloat()
    else 0f

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text       = plan.name,
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier   = Modifier.weight(1f),
                )
                StatusChip(plan.status)
            }
            val planService = plan.serviceName
            if (!planService.isNullOrBlank()) {
                Text(
                    text  = planService,
                    style = MaterialTheme.typography.bodySmall,
                    color = WellnessTextSecondary,
                )
            }
            Spacer(Modifier.height(Dimens.SpacingSm))
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text  = "${plan.completedSessions} / ${plan.totalSessions} sessions",
                    style = MaterialTheme.typography.bodySmall,
                    color = WellnessTextSecondary,
                )
                Text(
                    text       = "${(progress * 100).toInt()}%",
                    style      = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Medium,
                    color      = WellnessPrimary,
                )
            }
            Spacer(Modifier.height(Dimens.SpacingXs))
            LinearProgressIndicator(
                progress   = { progress },
                modifier   = Modifier.fillMaxWidth(),
                color      = WellnessPrimary,
                trackColor = WellnessPrimary.copy(alpha = 0.12f),
            )
            val planPrice = plan.totalPrice
            if (planPrice != null && planPrice > 0) {
                Spacer(Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = "₹${planPrice.toLong()}",
                    style = MaterialTheme.typography.bodySmall,
                    color = WellnessTextSecondary,
                )
            }
        }
    }
}

@Composable
private fun StatusChip(status: String) {
    val color = when (status.uppercase()) {
        "ACTIVE"    -> WellnessPrimary
        "COMPLETED" -> MaterialTheme.colorScheme.tertiary
        "CANCELLED" -> MaterialTheme.colorScheme.error
        else        -> WellnessTextSecondary
    }
    Text(
        text  = status,
        style = MaterialTheme.typography.labelSmall,
        color = color,
    )
}
