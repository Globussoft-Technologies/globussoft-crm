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
import androidx.compose.material.icons.filled.MedicalServices
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessDropdown
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.core.domain.model.Prescription
import com.globussoft.wellness.feature.patients.presentation.detail.PatientDetailEvent
import com.globussoft.wellness.feature.patients.presentation.detail.PatientDetailUiState

/**
 * Tab 1 — Prescription.
 *
 * Form at top (new Rx) + list of past prescriptions below.
 * A visit must be selected to associate the Rx — the backend requires visitId.
 */
@Composable
fun PrescriptionTab(
    state: PatientDetailUiState,
    onEvent: (PatientDetailEvent) -> Unit,
) {
    var selectedVisitId by remember { mutableStateOf("") }
    var drugName        by remember { mutableStateOf("") }
    var dosage          by remember { mutableStateOf("") }
    var frequency       by remember { mutableStateOf("") }
    var duration        by remember { mutableStateOf("") }
    var instructions    by remember { mutableStateOf("") }
    var drugNameError   by remember { mutableStateOf<String?>(null) }
    var visitError      by remember { mutableStateOf<String?>(null) }

    val visitOptions = listOf("" to "Select visit…") +
        state.visits.map { v ->
            val label = buildString {
                append(v.visitDate.take(10))
                if (!v.serviceName.isNullOrBlank()) append(" — ${v.serviceName}")
            }
            v.id to label
        }

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
                        text       = "New Prescription",
                        style      = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color      = WellnessPrimary,
                    )

                    if (state.visits.isEmpty()) {
                        Text(
                            text  = "Log a visit first — prescriptions must be tied to a visit.",
                            style = MaterialTheme.typography.bodySmall,
                            color = WellnessTextSecondary,
                        )
                    } else {
                        WellnessDropdown(
                            value         = selectedVisitId,
                            onValueChange = { selectedVisitId = it; visitError = null },
                            label         = "Visit *",
                            options       = visitOptions,
                        )
                        if (visitError != null) {
                            Text(
                                text     = visitError!!,
                                color    = MaterialTheme.colorScheme.error,
                                style    = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(start = Dimens.SpacingLg),
                            )
                        }

                        WellnessTextField(
                            value         = drugName,
                            onValueChange = { drugName = it; drugNameError = null },
                            label         = "Drug / Medicine Name *",
                            isError       = drugNameError != null,
                            errorMessage  = drugNameError,
                            imeAction     = ImeAction.Next,
                        )

                        WellnessTextField(
                            value         = dosage,
                            onValueChange = { dosage = it },
                            label         = "Dosage (e.g. 500 mg)",
                            imeAction     = ImeAction.Next,
                        )

                        Row(
                            modifier              = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                        ) {
                            WellnessTextField(
                                value         = frequency,
                                onValueChange = { frequency = it },
                                label         = "Frequency",
                                placeholder   = "Twice daily",
                                imeAction     = ImeAction.Next,
                                modifier      = Modifier.weight(1f),
                            )
                            WellnessTextField(
                                value         = duration,
                                onValueChange = { duration = it },
                                label         = "Duration",
                                placeholder   = "7 days",
                                imeAction     = ImeAction.Next,
                                modifier      = Modifier.weight(1f),
                            )
                        }

                        WellnessTextField(
                            value         = instructions,
                            onValueChange = { instructions = it },
                            label         = "Special Instructions",
                            placeholder   = "Take after meals…",
                            singleLine    = false,
                            maxLines      = 3,
                            imeAction     = ImeAction.Default,
                        )

                        if (state.createRxError != null) {
                            Text(
                                text  = state.createRxError,
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }

                        WellnessButton(
                            text      = "Save Prescription",
                            isLoading = state.isCreatingRx,
                            onClick   = {
                                var valid = true
                                if (selectedVisitId.isBlank()) {
                                    visitError = "Please select a visit"; valid = false
                                }
                                if (drugName.isBlank()) {
                                    drugNameError = "Drug name is required"; valid = false
                                }
                                if (!valid) return@WellnessButton
                                onEvent(
                                    PatientDetailEvent.CreatePrescription(
                                        visitId      = selectedVisitId,
                                        drugName     = drugName,
                                        dosage       = dosage,
                                        frequency    = frequency,
                                        duration     = duration,
                                        instructions = instructions,
                                    )
                                )
                                selectedVisitId = ""; drugName = ""; dosage = ""
                                frequency = ""; duration = ""; instructions = ""
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }

        item {
            HorizontalDivider(
                modifier = Modifier.padding(vertical = Dimens.SpacingSm),
                color    = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
            )
            Text(
                text       = "Past Prescriptions",
                style      = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color      = WellnessTextSecondary,
                modifier   = Modifier.padding(bottom = Dimens.SpacingSm),
            )
        }

        if (state.prescriptions.isEmpty()) {
            item {
                EmptyState(
                    message  = "No prescriptions on file yet.",
                    icon     = Icons.Default.MedicalServices,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        } else {
            items(state.prescriptions) { rx ->
                PrescriptionCard(rx)
            }
        }
    }
}

@Composable
private fun PrescriptionCard(rx: Prescription) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text       = rx.createdAt.take(10),
                    style      = MaterialTheme.typography.labelSmall,
                    color      = WellnessTextSecondary,
                )
                if (!rx.doctorName.isNullOrBlank()) {
                    Text(
                        text  = "Dr. ${rx.doctorName}",
                        style = MaterialTheme.typography.labelSmall,
                        color = WellnessPrimary,
                    )
                }
            }
            Spacer(Modifier.height(Dimens.SpacingXs))
            rx.drugs.forEach { drug ->
                val line = buildString {
                    append("• ${drug.name}")
                    if (!drug.dosage.isNullOrBlank()) append("  ${drug.dosage}")
                    if (!drug.frequency.isNullOrBlank()) append("  ·  ${drug.frequency}")
                    if (!drug.duration.isNullOrBlank()) append("  ·  ${drug.duration}")
                }
                Text(
                    text  = line,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            val rxInstructions = rx.instructions
            if (!rxInstructions.isNullOrBlank()) {
                Spacer(Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = rxInstructions,
                    style = MaterialTheme.typography.bodySmall,
                    color = WellnessTextSecondary,
                )
            }
        }
    }
}
