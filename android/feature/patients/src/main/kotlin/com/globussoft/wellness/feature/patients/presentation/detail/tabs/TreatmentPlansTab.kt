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
import androidx.compose.material.icons.filled.List
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.core.domain.model.Patient

/**
 * Tab 3 — Treatment Plans.
 *
 * Lists all treatment plans for the patient with a [LinearProgressIndicator]
 * showing session completion (completed / total).
 *
 * NOTE: Treatment plan data is loaded from the future
 * `GET /wellness/patients/{id}/treatment-plans` endpoint. Until that endpoint
 * is wired into the repository the tab renders placeholder cards whose count
 * matches [Patient.treatmentPlanCount] so the UI skeleton is demonstrably
 * correct.
 */
@Composable
fun TreatmentPlansTab(patient: Patient) {
    if (patient.treatmentPlanCount == 0) {
        EmptyState(
            message  = "No treatment plans on file.\nCreate one during a consultation.",
            icon     = Icons.Default.List,
            modifier = Modifier.fillMaxSize(),
        )
        return
    }

    LazyColumn(
        contentPadding  = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        modifier = Modifier.fillMaxSize(),
    ) {
        items(count = patient.treatmentPlanCount) { index ->
            TreatmentPlanCard(
                planName       = "Treatment Plan ${index + 1}",
                totalSessions  = 10,
                completedSessions = minOf(patient.visitsCount, 10),
            )
        }
    }
}

@Composable
private fun TreatmentPlanCard(
    planName: String,
    totalSessions: Int,
    completedSessions: Int,
) {
    val progress = if (totalSessions > 0) completedSessions.toFloat() / totalSessions.toFloat() else 0f

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
            Text(
                text  = planName,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(Dimens.SpacingXs))
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text  = "$completedSessions / $totalSessions sessions",
                    style = MaterialTheme.typography.bodySmall,
                    color = WellnessTextSecondary,
                )
                Text(
                    text  = "${(progress * 100).toInt()}%",
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Medium,
                    color = WellnessPrimary,
                )
            }
            Spacer(Modifier.height(Dimens.SpacingSm))
            LinearProgressIndicator(
                progress       = { progress },
                modifier       = Modifier.fillMaxWidth(),
                color          = WellnessPrimary,
                trackColor     = WellnessPrimary.copy(alpha = 0.12f),
            )
        }
    }
}
