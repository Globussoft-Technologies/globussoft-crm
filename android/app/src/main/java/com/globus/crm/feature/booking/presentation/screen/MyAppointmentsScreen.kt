package com.globus.crm.feature.booking.presentation.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.ui.StatusChip
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.booking.domain.model.Appointment
import com.globus.crm.feature.booking.presentation.state.MyAppointmentsUiEvent
import com.globus.crm.feature.booking.presentation.state.MyAppointmentsUiState
private val TAB_LABELS = listOf("Upcoming", "Pending", "Completed", "Cancelled")

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun MyAppointmentsScreen(
    state: MyAppointmentsUiState,
    onEvent: (MyAppointmentsUiEvent) -> Unit,
) {
    var selectedTab by remember { mutableIntStateOf(0) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var isRefreshing by remember { mutableStateOf(false) }
    var detailAppointment by remember { mutableStateOf<Appointment?>(null) }
    LaunchedEffect(state.isLoading) { if (!state.isLoading) isRefreshing = false }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // 4 KPI count cards
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                KpiCard(
                    label = "Upcoming",
                    count = state.upcoming.size,
                    modifier = Modifier.weight(1f),
                )
                KpiCard(
                    label = "Pending",
                    count = state.pending.size,
                    modifier = Modifier.weight(1f),
                )
                KpiCard(
                    label = "Completed",
                    count = state.past.size,
                    modifier = Modifier.weight(1f),
                )
                KpiCard(
                    label = "Cancelled",
                    count = state.cancelled.size,
                    modifier = Modifier.weight(1f),
                )
            }

            ScrollableTabRow(selectedTabIndex = selectedTab, edgePadding = 0.dp) {
                TAB_LABELS.forEachIndexed { index, label ->
                    Tab(
                        selected = selectedTab == index,
                        onClick = { selectedTab = index },
                        text = { Text(label) },
                    )
                }
            }

            PullToRefreshBox(
                isRefreshing = isRefreshing,
                onRefresh = { isRefreshing = true; onEvent(MyAppointmentsUiEvent.Refresh) },
                modifier = Modifier.fillMaxSize(),
            ) {
                when {
                    state.isLoading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                    state.error != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        ErrorState(
                            message = state.error,
                            onRetry = { onEvent(MyAppointmentsUiEvent.Refresh) },
                        )
                    }
                    else -> {
                        val list = when (selectedTab) {
                            0 -> state.upcoming
                            1 -> state.pending
                            2 -> state.past
                            else -> state.cancelled
                        }
                        val emptyLabel = TAB_LABELS[selectedTab].let { "No $it appointments" }.lowercase()
                            .replaceFirstChar { it.uppercase() }
                        if (list.isEmpty()) {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Text(
                                    text = emptyLabel,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        } else {
                            LazyColumn(
                                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 96.dp),
                                verticalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                items(list) { appt ->
                                    AppointmentCard(
                                        appointment = appt,
                                        onClick = { onEvent(MyAppointmentsUiEvent.ShowActionSheet(appt)) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        FloatingActionButton(
            onClick = { onEvent(MyAppointmentsUiEvent.NavigateToBook) },
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(16.dp),
        ) {
            Icon(Icons.Default.Add, contentDescription = "Book appointment")
        }
    }

    // Cancel confirmation dialog
    if (state.showCancelConfirmDialog) {
        AlertDialog(
            onDismissRequest = { onEvent(MyAppointmentsUiEvent.DismissCancel) },
            title = { Text("Cancel appointment?") },
            text = {
                val apptName = state.appointmentToCancel?.serviceName ?: "this appointment"
                Text("Are you sure you want to cancel $apptName? This action cannot be undone.")
            },
            confirmButton = {
                Button(onClick = { onEvent(MyAppointmentsUiEvent.ConfirmCancel) }) {
                    Text("Cancel appointment")
                }
            },
            dismissButton = {
                TextButton(onClick = { onEvent(MyAppointmentsUiEvent.DismissCancel) }) {
                    Text("Keep it")
                }
            },
        )
    }

    // Action sheet — shown when a card is tapped
    state.actionSheetAppointment?.let { appt ->
        ModalBottomSheet(
            onDismissRequest = { onEvent(MyAppointmentsUiEvent.DismissActionSheet) },
            sheetState = sheetState,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(bottom = 16.dp),
            ) {
                Text(
                    text = appt.serviceName ?: "Appointment",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
                )
                androidx.compose.material3.HorizontalDivider()
                ActionSheetItem(
                    label = "View details",
                    onClick = {
                        detailAppointment = appt
                        onEvent(MyAppointmentsUiEvent.DismissActionSheet)
                    },
                )
                if (appt.canReschedule) {
                    ActionSheetItem(
                        label = "Reschedule",
                        onClick = { onEvent(MyAppointmentsUiEvent.ShowRescheduleSheet(appt.id)) },
                    )
                }
                if (appt.canCancel) {
                    ActionSheetItem(
                        label = "Cancel appointment",
                        labelColor = MaterialTheme.colorScheme.error,
                        onClick = { onEvent(MyAppointmentsUiEvent.RequestCancel(appt)) },
                    )
                }
            }
        }
    }

    if (state.rescheduleSheetAppointmentId != null) {
        var selectedDate by remember { mutableStateOf<String?>(null) }
        var selectedTime by remember { mutableStateOf<String?>(null) }
        var showDatePicker by remember { mutableStateOf(false) }
        var showTimePicker by remember { mutableStateOf(false) }

        val datePickerState = rememberDatePickerState(
            initialSelectedDateMillis = System.currentTimeMillis(),
            selectableDates = object : androidx.compose.material3.SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long) = utcTimeMillis >= System.currentTimeMillis() - 86_400_000L
            },
        )
        val timePickerState = rememberTimePickerState(initialHour = 9, initialMinute = 0, is24Hour = true)

        ModalBottomSheet(
            onDismissRequest = { onEvent(MyAppointmentsUiEvent.DismissRescheduleSheet) },
            sheetState = sheetState,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(horizontal = 20.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text("Reschedule Appointment", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)

                OutlinedButton(
                    onClick = { showDatePicker = true },
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Icon(Icons.Default.CalendarToday, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(selectedDate ?: "Select date", style = MaterialTheme.typography.bodyMedium)
                }

                OutlinedButton(
                    onClick = { showTimePicker = true },
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Icon(Icons.Default.Schedule, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(selectedTime ?: "Select time", style = MaterialTheme.typography.bodyMedium)
                }

                if (state.rescheduleError != null) {
                    Text(
                        text = state.rescheduleError,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }

                Button(
                    onClick = {
                        val d = selectedDate ?: return@Button
                        val t = selectedTime ?: return@Button
                        onEvent(MyAppointmentsUiEvent.ConfirmReschedule(d, t))
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp),
                    enabled = selectedDate != null && selectedTime != null && !state.isRescheduling,
                    shape = MaterialTheme.shapes.extraLarge,
                ) {
                    if (state.isRescheduling) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    } else {
                        Text("Confirm Reschedule")
                    }
                }

                Spacer(Modifier.height(8.dp))
            }
        }

        if (showDatePicker) {
            DatePickerDialog(
                onDismissRequest = { showDatePicker = false },
                confirmButton = {
                    TextButton(onClick = {
                        datePickerState.selectedDateMillis?.let { ms ->
                            val sdf = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.getDefault())
                            selectedDate = sdf.format(java.util.Date(ms))
                            selectedTime = null
                        }
                        showDatePicker = false
                    }) { Text("OK") }
                },
                dismissButton = {
                    TextButton(onClick = { showDatePicker = false }) { Text("Cancel") }
                },
            ) {
                DatePicker(state = datePickerState, showModeToggle = false)
            }
        }

        if (showTimePicker) {
            AlertDialog(
                onDismissRequest = { showTimePicker = false },
                title = { Text("Select time", style = MaterialTheme.typography.titleMedium) },
                text = {
                    Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxWidth()) {
                        TimePicker(state = timePickerState)
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        val h = timePickerState.hour.toString().padStart(2, '0')
                        val m = timePickerState.minute.toString().padStart(2, '0')
                        selectedTime = "$h:$m"
                        showTimePicker = false
                    }) { Text("OK") }
                },
                dismissButton = {
                    TextButton(onClick = { showTimePicker = false }) { Text("Cancel") }
                },
            )
        }
    }

    detailAppointment?.let { appt ->
        AppointmentDetailSheet(appointment = appt, onDismiss = { detailAppointment = null })
    }
}

@Composable
private fun KpiCard(label: String, count: Int, modifier: Modifier = Modifier) {
    ElevatedCard(modifier = modifier) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 10.dp, horizontal = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = count.toString(),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun AppointmentCard(
    appointment: Appointment,
    onClick: () -> Unit,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = appointment.serviceName ?: "Appointment",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    if (!appointment.doctorName.isNullOrBlank()) {
                        Text(
                            text = "with ${appointment.doctorName}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                StatusChip(status = appointment.status)
            }
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = DateUtil.toDisplayDateTime(appointment.appointmentDate),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            if (!appointment.reason.isNullOrBlank()) {
                Text(
                    text = appointment.reason,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun ActionSheetItem(
    label: String,
    onClick: () -> Unit,
    labelColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurface,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = labelColor,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppointmentDetailSheet(appointment: Appointment, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = appointment.serviceName ?: "Appointment",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            androidx.compose.material3.HorizontalDivider()
            DetailInfoRow("Status", appointment.status)
            DetailInfoRow("Date & Time", DateUtil.toDisplayDateTime(appointment.appointmentDate))
            if (!appointment.doctorName.isNullOrBlank()) DetailInfoRow("Doctor", appointment.doctorName)
            if (!appointment.reason.isNullOrBlank()) DetailInfoRow("Reason", appointment.reason)
            DetailInfoRow("ID", "#${appointment.id}")
        }
    }
}

@Composable
private fun DetailInfoRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
    }
}
