package com.globus.crm.feature.booking.presentation.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.ui.SectionLabel
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.core.util.CurrencyUtil
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.booking.domain.model.Visit
import com.globus.crm.feature.booking.presentation.state.VisitHistoryUiEvent
import com.globus.crm.feature.booking.presentation.state.VisitHistoryUiState

@Composable
fun VisitHistoryScreen(
    state: VisitHistoryUiState,
    onEvent: (VisitHistoryUiEvent) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading -> CircularProgressIndicator(
                modifier = Modifier.align(Alignment.Center),
            )
            state.error != null -> ErrorState(
                message = state.error,
                onRetry = { onEvent(VisitHistoryUiEvent.Refresh) },
                modifier = Modifier.align(Alignment.Center),
            )
            state.visits.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No visits yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> LazyColumn(
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                val grouped = state.visits.groupBy { DateUtil.toDisplayMonthYear(it.visitDate) }
                grouped.forEach { (monthLabel, visits) ->
                    item {
                        SectionLabel(
                            text = monthLabel,
                            modifier = Modifier.padding(vertical = 4.dp),
                        )
                    }
                    items(visits) { visit ->
                        VisitCard(
                            visit = visit,
                            onClick = { onEvent(VisitHistoryUiEvent.SelectVisit(visit)) },
                        )
                    }
                }
            }
        }
    }

    state.selectedVisit?.let { visit ->
        VisitDetailSheet(visit = visit, onDismiss = { onEvent(VisitHistoryUiEvent.DismissDetail) })
    }
}

@Composable
private fun VisitCard(visit: Visit, onClick: () -> Unit) {
    WellnessCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Row(
            modifier = Modifier.padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = visit.serviceName ?: "Visit",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                if (!visit.doctorName.isNullOrBlank()) {
                    Text(
                        text = visit.doctorName,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    text = DateUtil.toDisplayDate(visit.visitDate),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            if (visit.amountCharged != null) {
                Text(
                    text = CurrencyUtil.formatRupees(visit.amountCharged),
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VisitDetailSheet(visit: Visit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Visit Details", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            HorizontalDivider()
            DetailRow("Service", visit.serviceName ?: "—")
            DetailRow("Doctor", visit.doctorName ?: "Not assigned")
            DetailRow("Date", DateUtil.toDisplayDate(visit.visitDate))
            DetailRow("Status", visit.status)
            if (visit.locationName != null) DetailRow("Location", visit.locationName)
            if (visit.bookingType != null) DetailRow("Type", visit.bookingType)
            if (visit.amountCharged != null) DetailRow("Amount", CurrencyUtil.formatRupees(visit.amountCharged))
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
    }
}
