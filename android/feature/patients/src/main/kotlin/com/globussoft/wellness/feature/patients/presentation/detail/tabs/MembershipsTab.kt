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
import androidx.compose.material.icons.filled.CardMembership
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.core.designsystem.theme.WellnessWarning
import com.globussoft.wellness.core.domain.model.Patient

/**
 * Tab 9 — Memberships.
 *
 * Shows cards for purchased membership / package plans with:
 * - Plan name and status badge
 * - Expiry date
 * - Sessions remaining per service with a [LinearProgressIndicator]
 *
 * Membership data will be loaded from the future
 * `GET /wellness/patients/{id}/memberships` endpoint. The tab renders
 * placeholder cards proportional to [Patient.treatmentPlanCount] until
 * that endpoint is available.
 */
@Composable
fun MembershipsTab(patient: Patient) {
    if (patient.treatmentPlanCount == 0) {
        EmptyState(
            message  = "No active memberships.\nPurchase a package plan to track session credits here.",
            icon     = Icons.Default.CardMembership,
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
            val sessionsTotal     = 10 + index * 5
            val sessionsUsed      = minOf(patient.visitsCount, sessionsTotal)
            val sessionsRemaining = sessionsTotal - sessionsUsed
            val isExpiringSoon    = sessionsRemaining <= 2

            MembershipCard(
                planName          = "Wellness Package ${index + 1}",
                expiryDate        = "2026-${if (index % 2 == 0) "08" else "11"}-30",
                sessionsTotal     = sessionsTotal,
                sessionsRemaining = sessionsRemaining,
                isExpiringSoon    = isExpiringSoon,
                serviceName       = listOf(
                    "Full Body Massage",
                    "Hydrafacial",
                    "Laser Hair Reduction",
                    "Anti-Aging Treatment",
                ).getOrElse(index % 4) { "Treatment Package" },
            )
        }
    }
}

@Composable
private fun MembershipCard(
    planName: String,
    expiryDate: String,
    sessionsTotal: Int,
    sessionsRemaining: Int,
    isExpiringSoon: Boolean,
    serviceName: String,
) {
    val sessionsUsed = sessionsTotal - sessionsRemaining
    val progress     = if (sessionsTotal > 0) sessionsUsed.toFloat() / sessionsTotal.toFloat() else 0f

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
            // Header row: plan name + status badge
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text  = planName,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                StatusBadge(
                    status = if (isExpiringSoon) "WAITING" else "CONFIRMED",
                )
            }

            Spacer(Modifier.height(Dimens.SpacingXs))

            // Service name and expiry
            Text(
                text  = serviceName,
                style = MaterialTheme.typography.bodySmall,
                color = WellnessPrimary,
            )
            Text(
                text  = "Expires: $expiryDate",
                style = MaterialTheme.typography.bodySmall,
                color = if (isExpiringSoon) WellnessWarning else WellnessTextSecondary,
            )

            Spacer(Modifier.height(Dimens.SpacingSm))

            // Session usage progress bar
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text  = "$sessionsRemaining sessions remaining",
                    style = MaterialTheme.typography.bodySmall,
                    color = WellnessTextSecondary,
                )
                Text(
                    text  = "$sessionsUsed / $sessionsTotal",
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Medium,
                    color = WellnessPrimary,
                )
            }
            Spacer(Modifier.height(Dimens.SpacingXs))
            LinearProgressIndicator(
                progress  = { progress },
                modifier  = Modifier.fillMaxWidth(),
                color     = if (isExpiringSoon) WellnessWarning else WellnessPrimary,
                trackColor = WellnessPrimary.copy(alpha = 0.12f),
            )

            if (isExpiringSoon) {
                Spacer(Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = "Only $sessionsRemaining session(s) left — consider renewing.",
                    style = MaterialTheme.typography.labelSmall,
                    color = WellnessWarning,
                )
            }
        }
    }
}
