package com.globussoft.wellness.feature.patients.presentation.detail.tabs

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessAccent
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.core.domain.model.Visit

/**
 * Tab 0 — Case History.
 *
 * Renders a reverse-chronological list of [Visit] cards. Each card shows:
 * - Visit date and booking type
 * - Service name (if available)
 * - Doctor name (if available)
 * - Status badge
 * - Amount billed (if available)
 * - Notes (if any)
 */
@Composable
fun CaseHistoryTab(visits: List<Visit>) {
    if (visits.isEmpty()) {
        EmptyState(
            message  = "No visits yet.\nLog the first visit using the Log Visit tab.",
            icon     = Icons.Default.CalendarMonth,
            modifier = Modifier.fillMaxSize(),
        )
        return
    }

    LazyColumn(
        contentPadding  = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        modifier = Modifier.fillMaxSize(),
    ) {
        items(items = visits, key = { it.id }) { visit ->
            VisitCard(visit = visit)
        }
    }
}

@Composable
private fun VisitCard(visit: Visit) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.height(IntrinsicSize.Min)) {
            // Color-coded left border: visits use the accent (blush) color
            Box(
                modifier = Modifier
                    .width(3.dp)
                    .fillMaxHeight()
                    .background(WellnessAccent),
            )
            Column(modifier = Modifier.padding(Dimens.SpacingMd).weight(1f)) {
                // Top row: date + status badge
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment     = Alignment.CenterVertically,
                ) {
                    Text(
                        text       = formatVisitDate(visit.visitDate),
                        style      = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    StatusBadge(status = visit.status.name)
                }

                Spacer(Modifier.height(Dimens.SpacingXs))

                // Service name
                val visitServiceName = visit.serviceName
                if (!visitServiceName.isNullOrBlank()) {
                    LabeledValue(label = "Service", value = visitServiceName)
                }

                // Doctor
                val visitDoctorName = visit.doctorName
                if (!visitDoctorName.isNullOrBlank()) {
                    LabeledValue(label = "Doctor", value = visitDoctorName)
                }

                // Booking type
                LabeledValue(
                    label = "Type",
                    value = visit.bookingType.name.replace('_', ' ').lowercase()
                        .replaceFirstChar { it.uppercase() },
                )

                // Amount
                if (visit.amount != null) {
                    LabeledValue(
                        label = "Amount",
                        value = "₹${"%.0f".format(visit.amount)}",
                    )
                }

                // Notes
                val visitNotes = visit.notes
                if (!visitNotes.isNullOrBlank()) {
                    Spacer(Modifier.height(Dimens.SpacingXs))
                    Text(
                        text  = visitNotes,
                        style = MaterialTheme.typography.bodySmall,
                        color = WellnessTextSecondary,
                    )
                }
            }   // Column
        }   // Row (left-border + content)
    }   // WellnessCard
}

@Composable
private fun LabeledValue(label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text  = "$label: ",
            style = MaterialTheme.typography.bodySmall,
            color = WellnessTextSecondary,
        )
        Text(
            text  = value,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}

private fun formatVisitDate(iso: String): String = try {
    iso.substring(0, 10)
} catch (_: Exception) { iso }
