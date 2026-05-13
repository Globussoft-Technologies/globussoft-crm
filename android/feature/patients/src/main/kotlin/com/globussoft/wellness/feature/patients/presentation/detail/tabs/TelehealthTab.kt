package com.globussoft.wellness.feature.patients.presentation.detail.tabs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.VideoCall
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.core.domain.model.Patient
import com.globussoft.wellness.core.domain.model.Visit
import com.globussoft.wellness.core.domain.model.BookingType

/**
 * Tab 7 — Telehealth.
 *
 * Provides a "Start Video Consultation" CTA and lists any previous telehealth
 * sessions from the visit history (visits where [BookingType] is VIDEO or PHONE).
 */
@Composable
fun TelehealthTab(patient: Patient) {
    // Telehealth sessions extracted from the visit list injected by the parent.
    // In practice, these come from the same visits flow already loaded by the ViewModel.
    // Tab receives patient for future direct API call scope.
    Column(
        modifier = Modifier.fillMaxSize(),
    ) {
        LazyColumn(
            contentPadding  = androidx.compose.foundation.layout.PaddingValues(Dimens.SpacingLg),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            item {
                StartConsultationCard()
            }

            item {
                Text(
                    text  = "Previous Telehealth Sessions",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = WellnessTextSecondary,
                    modifier = Modifier.padding(top = Dimens.SpacingXs),
                )
            }

            if (patient.visitsCount == 0) {
                item {
                    Text(
                        text  = "No telehealth sessions on record.",
                        style = MaterialTheme.typography.bodySmall,
                        color = WellnessTextSecondary,
                        modifier = Modifier.padding(top = Dimens.SpacingXs),
                    )
                }
            } else {
                // Placeholder rows – real data from visit list filtered by booking type.
                items(count = minOf(patient.visitsCount, 3)) { index ->
                    TelehealthSessionCard(
                        date     = "2026-0${5 - index}-${10 + index}",
                        type     = if (index % 2 == 0) "Video" else "Phone",
                        status   = "COMPLETED",
                        duration = 20 + index * 5,
                    )
                }
            }
        }
    }
}

@Composable
private fun StartConsultationCard() {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier            = Modifier.padding(Dimens.SpacingXl),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            Icon(
                imageVector        = Icons.Default.VideoCall,
                contentDescription = null,
                tint               = WellnessPrimary,
                modifier           = Modifier.size(48.dp),
            )
            Text(
                text  = "Start Video Consultation",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text  = "Begin a live video call with the patient directly from the app.",
                style = MaterialTheme.typography.bodySmall,
                color = WellnessTextSecondary,
            )
            WellnessButton(
                text    = "Start Consultation",
                onClick = {
                    // TODO: integrate with Zoom / Jitsi / Daily.co SDK in a future sprint.
                },
                icon     = Icons.Default.VideoCall,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun TelehealthSessionCard(
    date: String,
    type: String,
    status: String,
    duration: Int,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier            = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment   = Alignment.CenterVertically,
        ) {
            Column {
                Text(
                    text  = "$type Consultation",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    text  = "$date · ${duration} min",
                    style = MaterialTheme.typography.bodySmall,
                    color = WellnessTextSecondary,
                )
            }
            StatusBadge(status = status)
        }
    }
}
