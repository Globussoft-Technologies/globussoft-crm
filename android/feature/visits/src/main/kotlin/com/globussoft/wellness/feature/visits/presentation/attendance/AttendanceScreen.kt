package com.globussoft.wellness.feature.visits.presentation.attendance

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessDangerButton
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.visits.domain.model.AttendanceRecord
import com.globussoft.wellness.feature.visits.domain.model.StaffAttendance
import kotlinx.coroutines.launch

// ─── Public composable ────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AttendanceScreen(
    viewModel: AttendanceViewModel = hiltViewModel(),
) {
    val state        by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHost = remember { SnackbarHostState() }
    val scope        = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is AttendanceEffect.ShowSnackbar -> scope.launch { snackbarHost.showSnackbar(effect.message) }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHost) },
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.AccessTime, contentDescription = null,
                            tint = WellnessPrimary, modifier = Modifier.size(22.dp))
                        Spacer(Modifier.width(Dimens.SpacingSm))
                        Text("Attendance", fontWeight = FontWeight.SemiBold)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        when {
            state.isLoading && state.todayData == null -> {
                Box(
                    modifier         = Modifier.fillMaxSize().padding(padding),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(color = WellnessPrimary, strokeWidth = 2.dp)
                }
            }
            state.error != null && state.todayData == null -> {
                ErrorState(
                    message  = state.error,
                    onRetry  = { viewModel.onEvent(AttendanceEvent.Refresh) },
                    modifier = Modifier.fillMaxSize().padding(padding),
                )
            }
            else -> {
                LazyColumn(
                    modifier        = Modifier.fillMaxSize().padding(padding),
                    contentPadding  = androidx.compose.foundation.layout.PaddingValues(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                ) {
                    // Today's card
                    item { TodayCard(state = state, onEvent = viewModel::onEvent) }

                    // My 30-day history
                    item {
                        Text("My Last 30 Days",
                            style      = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    if (state.history.isEmpty()) {
                        item {
                            Text("No history yet.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else {
                        item {
                            WellnessCard {
                                Column {
                                    AttendanceHistoryHeader()
                                    Divider()
                                    state.history.forEachIndexed { idx, record ->
                                        AttendanceHistoryRow(record = record)
                                        if (idx < state.history.lastIndex) Divider(thickness = 0.5.dp)
                                    }
                                }
                            }
                        }
                    }

                    // All Staff Today (manager only)
                    if (state.staffToday.isNotEmpty()) {
                        item {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.Groups, contentDescription = null,
                                    tint = WellnessPrimary, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.width(Dimens.SpacingSm))
                                Text("All Staff — Today",
                                    style      = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                        }
                        item {
                            WellnessCard {
                                Column {
                                    StaffAttendanceHeader()
                                    Divider()
                                    state.staffToday.forEachIndexed { idx, record ->
                                        StaffAttendanceRow(record = record)
                                        if (idx < state.staffToday.lastIndex) Divider(thickness = 0.5.dp)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ─── Today card ───────────────────────────────────────────────────────────────

@Composable
private fun TodayCard(
    state: AttendanceUiState,
    onEvent: (AttendanceEvent) -> Unit,
) {
    val today      = state.todayData
    val isClockedIn = today?.isClockedIn ?: false

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(WellnessPrimary, shape = RoundedCornerShape(Dimens.CornerLarge))
            .padding(Dimens.SpacingXl),
    ) {
        Column(
            modifier            = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            Text(
                text  = "Today",
                style = MaterialTheme.typography.labelLarge,
                color = Color.White.copy(alpha = 0.7f),
            )

            if (isClockedIn) {
                // Clock-in time + elapsed
                Text(
                    text       = "Clocked In",
                    style      = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color      = Color.White,
                )
                Text(
                    text  = "Since ${formatTime(today?.clockInAt)}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White.copy(alpha = 0.85f),
                )
                if (state.elapsedLabel.isNotBlank()) {
                    Box(
                        modifier = Modifier
                            .background(Color.White.copy(alpha = 0.15f), RoundedCornerShape(100))
                            .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingXs),
                    ) {
                        Text(
                            text       = state.elapsedLabel,
                            style      = MaterialTheme.typography.displaySmall,
                            fontWeight = FontWeight.Bold,
                            color      = Color.White,
                        )
                    }
                }
                Spacer(Modifier.height(Dimens.SpacingSm))
                WellnessDangerButton(
                    text      = if (state.isPunchingOut) "Punching Out…" else "Punch Out",
                    onClick   = { onEvent(AttendanceEvent.PunchOut) },
                    enabled   = !state.isPunchingOut,
                    modifier  = Modifier.fillMaxWidth(),
                )
            } else {
                // Not yet clocked in today
                Text(
                    text       = "Not Clocked In",
                    style      = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color      = Color.White,
                )
                if (today?.clockOutAt != null) {
                    Text(
                        text  = "Shift ended: ${formatTime(today.clockOutAt)}  •  ${today.duration ?: ""}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color.White.copy(alpha = 0.75f),
                        textAlign = TextAlign.Center,
                    )
                } else {
                    Text(
                        text  = "Tap below to start your shift.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color.White.copy(alpha = 0.75f),
                    )
                    Spacer(Modifier.height(Dimens.SpacingSm))
                    WellnessButton(
                        text      = if (state.isPunchingIn) "Punching In…" else "Punch In",
                        onClick   = { onEvent(AttendanceEvent.PunchIn) },
                        isLoading = state.isPunchingIn,
                        modifier  = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

// ─── History table ────────────────────────────────────────────────────────────

@Composable
private fun AttendanceHistoryHeader() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(WellnessPrimary.copy(alpha = 0.07f))
            .padding(horizontal = Dimens.SpacingMd, vertical = Dimens.SpacingSm),
    ) {
        Text("Date",     style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        Text("In",       style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        Text("Out",      style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        Text("Duration", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.8f))
        Text("Status",   style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.9f))
    }
}

@Composable
private fun AttendanceHistoryRow(record: AttendanceRecord) {
    Row(
        modifier          = Modifier
            .fillMaxWidth()
            .padding(horizontal = Dimens.SpacingMd, vertical = Dimens.SpacingSm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(record.date.take(10),               style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        Text(formatTime(record.clockIn) ?: "—",  style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        Text(formatTime(record.clockOut) ?: "—", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        Text(record.duration ?: "—",             style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(0.8f))
        StatusBadge(status = record.status, modifier = Modifier.weight(0.9f))
    }
}

// ─── All-staff today table ────────────────────────────────────────────────────

@Composable
private fun StaffAttendanceHeader() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(WellnessPrimary.copy(alpha = 0.07f))
            .padding(horizontal = Dimens.SpacingMd, vertical = Dimens.SpacingSm),
    ) {
        Text("Name",     style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1.5f))
        Text("Status",   style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.8f))
        Text("In",       style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.8f))
        Text("Out",      style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.8f))
        Text("Duration", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.8f))
    }
}

@Composable
private fun StaffAttendanceRow(record: StaffAttendance) {
    Row(
        modifier          = Modifier
            .fillMaxWidth()
            .padding(horizontal = Dimens.SpacingMd, vertical = Dimens.SpacingSm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(record.staffName,               style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1.5f))
        StatusBadge(status = record.status,  modifier = Modifier.weight(0.8f))
        Text(formatTime(record.clockIn) ?: "—",  style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(0.8f))
        Text(formatTime(record.clockOut) ?: "—", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(0.8f))
        Text(record.duration ?: "—",             style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(0.8f))
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

private fun formatTime(iso: String?): String? = iso?.let {
    try { it.substring(11, 16) } catch (_: Exception) { it }
}
