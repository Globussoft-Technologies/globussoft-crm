package com.globus.crm.feature.health.presentation.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globus.crm.core.ui.StatusChip
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.core.ui.WellnessProgressBar
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.health.domain.model.TreatmentPlan
import com.globus.crm.feature.health.presentation.state.TreatmentPlansUiEvent
import com.globus.crm.feature.health.presentation.state.TreatmentPlansUiState

@Composable
fun TreatmentPlansScreen(
    state: TreatmentPlansUiState,
    onEvent: (TreatmentPlansUiEvent) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            state.error != null -> Column(
                modifier = Modifier.align(Alignment.Center),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(state.error, color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(12.dp))
                Button(onClick = { onEvent(TreatmentPlansUiEvent.Refresh) }, shape = MaterialTheme.shapes.extraLarge) { Text("Retry") }
            }
            state.plans.isEmpty() -> Text(
                text = "No treatment plans found",
                modifier = Modifier.align(Alignment.Center),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            else -> LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(state.plans, key = { it.id }) { plan ->
                    TreatmentPlanCard(plan)
                }
            }
        }
    }
}

@Composable
private fun TreatmentPlanCard(plan: TreatmentPlan) {
    val progress = if (plan.totalSessions > 0) {
        plan.completedSessions.toFloat() / plan.totalSessions.toFloat()
    } else 0f

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = plan.name,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                StatusChip(status = plan.status)
            }

            if (plan.serviceName != null) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = plan.serviceName + if (plan.serviceCategory != null) " · ${plan.serviceCategory}" else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(12.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "Sessions",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = "${plan.completedSessions} / ${plan.totalSessions}",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Medium,
                )
            }
            Spacer(Modifier.height(4.dp))
            WellnessProgressBar(
                progress = progress,
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(8.dp))
            Text(
                text = "Started: ${DateUtil.toDisplayDate(plan.startedAt)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (plan.nextDueAt != null) {
                Text(
                    text = "Next due: ${DateUtil.toDisplayDate(plan.nextDueAt)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
