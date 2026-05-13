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
import androidx.compose.ui.text.input.KeyboardType
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.core.domain.model.Patient

/**
 * Tab 1 — Prescription.
 *
 * Displays a form to author a new prescription at the top. Below the form,
 * previous prescriptions are listed in reverse-chronological order.
 *
 * NOTE: The prescription list data comes from a future API endpoint
 * (`GET /wellness/patients/{id}/prescriptions`) that is not yet wired into
 * the repository. The UI renders the form fully and shows an empty state for
 * the list until the endpoint is available.
 */
@Composable
fun PrescriptionTab(patient: Patient) {
    var drugName by remember { mutableStateOf("") }
    var dosage by remember { mutableStateOf("") }
    var frequency by remember { mutableStateOf("") }
    var duration by remember { mutableStateOf("") }
    var instructions by remember { mutableStateOf("") }
    var drugNameError by remember { mutableStateOf<String?>(null) }

    LazyColumn(
        contentPadding  = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            WellnessCard(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.padding(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                ) {
                    Text(
                        text  = "New Prescription",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = WellnessPrimary,
                    )

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
                        label         = "Dosage (e.g. 500mg)",
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
                        placeholder   = "Take after meals, avoid alcohol…",
                        singleLine    = false,
                        maxLines      = 3,
                        imeAction     = ImeAction.Default,
                    )

                    WellnessButton(
                        text    = "Save Prescription",
                        onClick = {
                            if (drugName.isBlank()) {
                                drugNameError = "Drug name is required"
                            } else {
                                // TODO: wire to CreatePrescription use case once
                                //       the prescriptions API endpoint is available.
                                drugName     = ""
                                dosage       = ""
                                frequency    = ""
                                duration     = ""
                                instructions = ""
                            }
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
                text  = "Past Prescriptions",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = WellnessTextSecondary,
                modifier = Modifier.padding(bottom = Dimens.SpacingSm),
            )
        }

        // Prescriptions list (future endpoint)
        item {
            if (patient.rxCount == 0) {
                EmptyState(
                    message  = "No prescriptions on file yet.",
                    icon     = Icons.Default.MedicalServices,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                // Placeholder rows: real data will populate once
                // GET /wellness/patients/{id}/prescriptions is wired in.
                repeat(patient.rxCount) { index ->
                    WellnessCard(modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = Dimens.SpacingSm)) {
                        Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
                            Text(
                                text  = "Prescription #${index + 1}",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Medium,
                            )
                            Text(
                                text  = "Load prescription details from API",
                                style = MaterialTheme.typography.bodySmall,
                                color = WellnessTextSecondary,
                            )
                        }
                    }
                }
            }
        }
    }
}
