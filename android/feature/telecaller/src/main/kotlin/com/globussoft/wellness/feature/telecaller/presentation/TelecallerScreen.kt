package com.globussoft.wellness.feature.telecaller.presentation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.PhoneDisabled
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.ThumbDown
import androidx.compose.material.icons.filled.ThumbUp
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.common.utils.formatRelativeTime
import com.globussoft.wellness.core.common.utils.millisToIsoDate
import com.globussoft.wellness.core.designsystem.components.AdaptiveTwoPaneLayout
import com.globussoft.wellness.core.designsystem.components.ConfirmDialog
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.SlaTimer
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessDangerButton
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessAccent
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.core.designsystem.theme.WellnessWarning
import com.globussoft.wellness.core.domain.model.Lead
import kotlinx.coroutines.launch

// ─── Public composable ────────────────────────────────────────────────────────

/**
 * Telecaller Queue screen.
 *
 * Adapts to screen width:
 * - **Expanded (tablet landscape):** two-pane layout — queue list on the left
 *   (300 dp fixed), current lead + disposition panel on the right.
 * - **Compact / Medium (portrait):** full-screen single pane showing the current
 *   lead and disposition panel.
 *
 * The disposition bottom sheet appears on top in both layouts.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TelecallerScreen(
    viewModel: TelecallerViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is TelecallerEffect.ShowSnackbar -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title  = { Text("Telecaller Queue", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) },
                actions = {
                    if (!state.isLoading) {
                        IconButton(onClick = { viewModel.onEvent(TelecallerEvent.RefreshQueue) }) {
                            Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = WellnessPrimary)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            when {
                state.isLoading && state.queue.isEmpty() -> {
                    ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                }
                state.error != null && state.queue.isEmpty() -> {
                    ErrorState(
                        message  = state.error!!,
                        onRetry  = { viewModel.onEvent(TelecallerEvent.RefreshQueue) },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.queue.isEmpty() -> {
                    EmptyState(
                        message  = "Queue is empty. All leads have been disposed.",
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                else -> {
                    AdaptiveTwoPaneLayout(
                        showDetailPane   = state.currentLead != null,
                        listPane = {
                            QueueListPane(
                                queue         = state.queue,
                                currentLead   = state.currentLead,
                                onSelectLead  = { viewModel.onEvent(TelecallerEvent.LoadLead(it)) },
                            )
                        },
                        detailPane = {
                            if (state.currentLead != null) {
                                LeadDetailPane(
                                    lead         = state.currentLead!!,
                                    onDispose    = { type -> viewModel.onEvent(TelecallerEvent.SelectDisposition(type)) },
                                )
                            } else {
                                EmptyState(
                                    message  = "Select a lead from the queue",
                                    modifier = Modifier.fillMaxSize(),
                                )
                            }
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }

            // Disposition bottom sheet.
            if (state.showDispositionSheet && state.selectedDisposition != null) {
                DispositionSheet(
                    disposition    = state.selectedDisposition!!,
                    form           = state.dispositionForm,
                    services       = state.services,
                    isSubmitting   = state.isSubmitting,
                    submitError    = state.submitError,
                    onFieldChanged = { field, value -> viewModel.onEvent(TelecallerEvent.FormFieldChanged(field, value)) },
                    onSubmit       = { viewModel.onEvent(TelecallerEvent.SubmitDisposition) },
                    onDismiss      = { viewModel.onEvent(TelecallerEvent.DismissSheet) },
                )
            }

            // Confirm dialog for destructive dispositions.
            if (state.showConfirmDialog && state.selectedDisposition != null) {
                ConfirmDialog(
                    title         = "Confirm ${state.selectedDisposition!!.label}",
                    message       = "This will remove the lead from your queue. This action cannot be undone.",
                    confirmLabel  = state.selectedDisposition!!.label,
                    isDestructive = true,
                    onConfirm     = { viewModel.onEvent(TelecallerEvent.ConfirmDisposition) },
                    onDismiss     = { viewModel.onEvent(TelecallerEvent.DismissConfirm) },
                )
            }
        }
    }
}

// ─── Queue list pane ──────────────────────────────────────────────────────────

@Composable
private fun QueueListPane(
    queue: List<Lead>,
    currentLead: Lead?,
    onSelectLead: (String) -> Unit,
) {
    LazyColumn(
        contentPadding      = PaddingValues(Dimens.SpacingSm),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
    ) {
        items(queue) { lead ->
            val isSelected = lead.id == currentLead?.id
            QueueLeadCard(
                lead       = lead,
                isSelected = isSelected,
                onClick    = { onSelectLead(lead.id) },
            )
        }
    }
}

@Composable
private fun QueueLeadCard(
    lead: Lead,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    WellnessCard(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (isSelected) Modifier.border(2.dp, WellnessPrimary, MaterialTheme.shapes.medium)
                else Modifier
            ),
        onClick = onClick,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text       = lead.contactName,
                    style      = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines   = 1,
                    overflow   = TextOverflow.Ellipsis,
                )
                Text(
                    text  = lead.phone,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val leadSource = lead.source
                if (leadSource != null) {
                    Text(
                        text  = leadSource,
                        style = MaterialTheme.typography.labelSmall,
                        color = WellnessAccent,
                    )
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                LeadScoreChip(score = lead.leadScore)
                Spacer(modifier = Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = formatRelativeTime(lead.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

// ─── Lead detail pane ─────────────────────────────────────────────────────────

@Composable
private fun LeadDetailPane(
    lead: Lead,
    onDispose: (DispositionType) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingLg),
    ) {
        // Lead card.
        LeadCard(lead = lead)

        // Disposition buttons 2×3 grid.
        DispositionPanel(onDispose = onDispose)
    }
}

@Composable
private fun LeadCard(lead: Lead) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.Top,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text       = lead.contactName,
                        style      = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                        maxLines   = 2,
                        overflow   = TextOverflow.Ellipsis,
                    )
                    Spacer(modifier = Modifier.height(Dimens.SpacingXs))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector        = Icons.Default.Phone,
                            contentDescription = null,
                            tint               = WellnessPrimary,
                            modifier           = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(Dimens.SpacingXs))
                        Text(
                            text  = lead.phone,
                            style = MaterialTheme.typography.bodyMedium,
                            color = WellnessPrimary,
                        )
                    }
                }
                LeadScoreChip(score = lead.leadScore)
            }

            Spacer(modifier = Modifier.height(Dimens.SpacingMd))

            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                if (lead.source != null) {
                    StatusBadge(status = lead.source ?: "unknown")
                }
                Text(
                    text  = "Added: ${formatRelativeTime(lead.createdAt)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.weight(1f))
                SlaStatusBadge(createdAt = lead.createdAt, firstResponseAt = lead.firstResponseAt)
                SlaTimer(createdAtIso = lead.createdAt)
            }
        }
    }
}

@Composable
private fun LeadScoreChip(score: Int) {
    val (bgColor, textColor) = when {
        score >= 75 -> WellnessSuccess.copy(alpha = 0.15f) to WellnessSuccess
        score >= 50 -> WellnessWarning.copy(alpha = 0.15f) to WellnessWarning
        score >= 25 -> Color(0xFFEA580C).copy(alpha = 0.15f) to Color(0xFFEA580C)
        else        -> MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
    }

    Box(
        modifier = Modifier
            .background(color = bgColor, shape = RoundedCornerShape(100))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(
            text       = score.toString(),
            style      = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color      = textColor,
        )
    }
}

// ─── Disposition panel ────────────────────────────────────────────────────────

private data class DispositionButton(
    val type: DispositionType,
    val icon: ImageVector,
    val color: Color,
    val isOutlined: Boolean,
)

@Composable
private fun DispositionPanel(onDispose: (DispositionType) -> Unit) {
    val buttons = listOf(
        DispositionButton(DispositionType.INTERESTED,    Icons.Default.ThumbUp,      WellnessSuccess, false),
        DispositionButton(DispositionType.CALLBACK,      Icons.Default.Schedule,     WellnessWarning, false),
        DispositionButton(DispositionType.BOOKED,        Icons.Default.Event,        WellnessPrimary, false),
        DispositionButton(DispositionType.NOT_INTERESTED,Icons.Default.ThumbDown,    WellnessDanger,  true),
        DispositionButton(DispositionType.WRONG_NUMBER,  Icons.Default.PhoneDisabled,MaterialTheme.colorScheme.outline, true),
        DispositionButton(DispositionType.JUNK,          Icons.Default.Delete,       MaterialTheme.colorScheme.outline, true),
    )

    Column(verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd)) {
        buttons.chunked(2).forEach { row ->
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                row.forEach { btn ->
                    DispositionActionButton(
                        button    = btn,
                        onClick   = { onDispose(btn.type) },
                        modifier  = Modifier.weight(1f),
                    )
                }
                // Pad with empty weight if the row has only 1 item.
                if (row.size < 2) Spacer(modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun DispositionActionButton(
    button: DispositionButton,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (button.isOutlined) {
        OutlinedButton(
            onClick  = onClick,
            modifier = modifier.height(56.dp),
            colors   = ButtonDefaults.outlinedButtonColors(contentColor = button.color),
        ) {
            Icon(
                imageVector        = button.icon,
                contentDescription = null,
                modifier           = Modifier.size(18.dp),
                tint               = button.color,
            )
            Spacer(modifier = Modifier.width(Dimens.SpacingXs))
            Text(
                text     = button.type.label,
                style    = MaterialTheme.typography.labelMedium,
                color    = button.color,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    } else {
        androidx.compose.material3.Button(
            onClick  = onClick,
            modifier = modifier.height(56.dp),
            colors   = ButtonDefaults.buttonColors(
                containerColor = button.color,
                contentColor   = Color.White,
            ),
        ) {
            Icon(
                imageVector        = button.icon,
                contentDescription = null,
                modifier           = Modifier.size(18.dp),
            )
            Spacer(modifier = Modifier.width(Dimens.SpacingXs))
            Text(
                text     = button.type.label,
                style    = MaterialTheme.typography.labelMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ─── Disposition bottom sheet ─────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DispositionSheet(
    disposition: DispositionType,
    form: DispositionFormState,
    services: List<ServiceItem>,
    isSubmitting: Boolean,
    submitError: String?,
    onFieldChanged: (String, String) -> Unit,
    onSubmit: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState       = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg)
                .padding(bottom = Dimens.SpacingXxl),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            // Header.
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(12.dp)
                        .background(
                            color = if (disposition.isDestructive) WellnessDanger else WellnessPrimary,
                            shape = RoundedCornerShape(100),
                        ),
                )
                Spacer(modifier = Modifier.width(Dimens.SpacingSm))
                Text(
                    text       = disposition.label,
                    style      = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }

            HorizontalDivider()

            // Context-aware form.
            when (disposition) {
                DispositionType.INTERESTED -> {
                    NotesField(value = form.notes, onValueChange = { onFieldChanged("notes", it) })
                }
                DispositionType.CALLBACK -> {
                    CallbackDateTimeField(
                        value         = form.callbackDateTime,
                        onValueChange = { onFieldChanged("callbackDateTime", it) },
                    )
                    NotesField(value = form.notes, onValueChange = { onFieldChanged("notes", it) })
                }
                DispositionType.BOOKED -> {
                    ServiceDropdown(
                        selectedServiceId = form.appointmentServiceId,
                        services          = services,
                        onServiceSelected = { onFieldChanged("appointmentServiceId", it) },
                    )
                    OutlinedTextField(
                        value         = form.appointmentTime,
                        onValueChange = { onFieldChanged("appointmentTime", it) },
                        label         = { Text("Appointment Time *") },
                        modifier      = Modifier.fillMaxWidth(),
                        singleLine    = true,
                    )
                    NotesField(value = form.notes, onValueChange = { onFieldChanged("notes", it) })
                }
                DispositionType.NOT_INTERESTED -> {
                    NotesField(value = form.notes, onValueChange = { onFieldChanged("notes", it) })
                }
                DispositionType.WRONG_NUMBER, DispositionType.JUNK -> {
                    Text(
                        text  = "This will remove the lead from your queue. The action cannot be undone.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = WellnessDanger,
                    )
                }
            }

            // Error message.
            if (submitError != null) {
                Text(
                    text  = submitError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            // Submit button.
            if (disposition.isDestructive) {
                WellnessDangerButton(
                    text     = "Confirm ${disposition.label}",
                    onClick  = onSubmit,
                    enabled  = !isSubmitting,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                WellnessButton(
                    text      = "Submit",
                    onClick   = onSubmit,
                    isLoading = isSubmitting,
                    modifier  = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun NotesField(value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value         = value,
        onValueChange = onValueChange,
        label         = { Text("Notes") },
        modifier      = Modifier.fillMaxWidth(),
        minLines      = 3,
        maxLines      = 5,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CallbackDateTimeField(
    value: String,
    onValueChange: (String) -> Unit,
) {
    var showDatePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf(false) }
    var selectedDateMillis by remember { mutableStateOf<Long?>(null) }
    var selectedHour  by remember { mutableStateOf(9) }
    var selectedMinute by remember { mutableStateOf(0) }

    OutlinedTextField(
        value         = value,
        onValueChange = {},
        readOnly      = true,
        label         = { Text("Callback Date & Time *") },
        modifier      = Modifier
            .fillMaxWidth(),
        singleLine    = true,
        trailingIcon  = {
            TextButton(onClick = { showDatePicker = true }) {
                Text("Pick")
            }
        },
    )

    if (showDatePicker) {
        val datePickerState = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    selectedDateMillis = datePickerState.selectedDateMillis
                    showDatePicker = false
                    showTimePicker = true
                }) { Text("Next") }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) { Text("Cancel") }
            },
        ) {
            DatePicker(state = datePickerState)
        }
    }

    if (showTimePicker) {
        val timePickerState = rememberTimePickerState(initialHour = selectedHour, initialMinute = selectedMinute)
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showTimePicker = false },
            title = { Text("Select Time") },
            text  = { TimePicker(state = timePickerState) },
            confirmButton = {
                TextButton(onClick = {
                    selectedHour   = timePickerState.hour
                    selectedMinute = timePickerState.minute
                    showTimePicker = false
                    // Compose a datetime string from date + time.
                    val datePart = selectedDateMillis?.let { millisToIsoDate(it) } ?: ""
                    val timePart = "%02d:%02d".format(selectedHour, selectedMinute)
                    onValueChange("${datePart}T${timePart}:00")
                }) { Text("OK") }
            },
            dismissButton = {
                TextButton(onClick = { showTimePicker = false }) { Text("Cancel") }
            },
        )
    }
}

// ─── SLA status badge ─────────────────────────────────────────────────────────

/**
 * Stateless SLA status chip that mirrors the web frontend's `slaFor()` logic.
 *
 * Status thresholds (from TelecallerQueue.jsx #290):
 * - **SLA OK**     — lead is < 30 min old, OR [firstResponseAt] is set.
 * - **SLA WARN**   — 30 min – 4 hours.
 * - **SLA LATE**   — 4 h – 24 h.
 * - **SLA BREACH** — 24 h+.
 *
 * Because [createdAt] is a static string, the badge does NOT tick live — it
 * shows the status at the moment of composition. For real-time drift the screen
 * already has [SlaTimer] ticking next to this badge.
 *
 * @param createdAt      ISO-8601 lead creation timestamp.
 * @param firstResponseAt ISO-8601 first-response timestamp; when non-null the SLA
 *                        is considered satisfied.
 */
@Composable
private fun SlaStatusBadge(
    createdAt: String,
    firstResponseAt: String?,
) {
    val status = remember(createdAt, firstResponseAt) {
        if (!firstResponseAt.isNullOrBlank()) "ok"
        else {
            val ageMs = System.currentTimeMillis() - parseIsoToMillis(createdAt)
            val ageH  = ageMs / 3_600_000.0
            when {
                ageH < 0.5  -> "ok"
                ageH < 4.0  -> "warn"
                ageH < 24.0 -> "late"
                else        -> "breach"
            }
        }
    }
    val (label, color) = when (status) {
        "ok"     -> "SLA OK"     to WellnessSuccess
        "warn"   -> "SLA WARN"   to WellnessWarning
        "late"   -> "SLA LATE"   to Color(0xFFEF4444)
        else     -> "SLA BREACH" to Color(0xFF7C3AED)
    }
    Box(
        modifier = Modifier
            .background(color.copy(alpha = 0.12f), shape = RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Text(
            text       = label,
            style      = MaterialTheme.typography.labelSmall,
            color      = color,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

// ─── Service dropdown (Booked disposition) ────────────────────────────────────

/**
 * Exposed dropdown menu for selecting a service from the catalog.
 *
 * Falls back gracefully when [services] is empty (e.g. the catalog hasn't
 * loaded yet): shows a disabled field with placeholder text so the user
 * knows to wait rather than see a broken UI.
 *
 * @param selectedServiceId The id of the currently selected [ServiceItem], or blank.
 * @param services          The loaded service catalog items.
 * @param onServiceSelected Callback invoked with the selected service id.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ServiceDropdown(
    selectedServiceId: String,
    services: List<ServiceItem>,
    onServiceSelected: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedName = services.firstOrNull { it.id == selectedServiceId }?.name
        ?: if (services.isEmpty()) "Loading services…" else "Select service"

    ExposedDropdownMenuBox(
        expanded        = expanded,
        onExpandedChange = { if (services.isNotEmpty()) expanded = it },
    ) {
        OutlinedTextField(
            value         = selectedName,
            onValueChange = {},
            readOnly      = true,
            label         = { Text("Service *") },
            trailingIcon  = {
                Icon(
                    imageVector        = Icons.Default.ArrowDropDown,
                    contentDescription = null,
                    tint               = if (services.isEmpty())
                        MaterialTheme.colorScheme.onSurfaceVariant
                    else
                        WellnessPrimary,
                )
            },
            modifier  = Modifier
                .menuAnchor()
                .fillMaxWidth(),
            singleLine = true,
            enabled    = services.isNotEmpty(),
        )
        ExposedDropdownMenu(
            expanded        = expanded,
            onDismissRequest = { expanded = false },
        ) {
            services.forEach { service ->
                DropdownMenuItem(
                    text    = { Text(service.name, style = MaterialTheme.typography.bodyMedium) },
                    onClick = {
                        onServiceSelected(service.id)
                        expanded = false
                    },
                )
            }
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses an ISO-8601 UTC timestamp (e.g. `"2026-05-13T09:30:00.000Z"`) to epoch
 * milliseconds.  Returns 0 on any parse error so the SLA badge degrades to
 * "SLA BREACH" (safe: shows urgency) rather than crashing.
 */
private fun parseIsoToMillis(iso: String): Long = try {
    java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply {
        timeZone = java.util.TimeZone.getTimeZone("UTC")
    }.parse(iso)?.time ?: run {
        // Fallback: try without milliseconds (e.g. "2026-05-13T09:30:00Z")
        java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US).apply {
            timeZone = java.util.TimeZone.getTimeZone("UTC")
        }.parse(iso)?.time ?: 0L
    }
} catch (_: Exception) { 0L }

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "TelecallerScreen – queue loaded", showBackground = true)
@Composable
private fun TelecallerScreenPreview() {
    WellnessTheme {
        val lead = Lead(
            id           = "1",
            contactName  = "Priya Sharma",
            phone        = "+91 98765 43210",
            leadScore    = 82,
            source       = "IndiaMART",
            createdAt    = "2026-05-13T06:00:00Z",
            nextFollowUp = null,
            status       = "New",
        )
        LeadDetailPane(lead = lead, onDispose = {})
    }
}
