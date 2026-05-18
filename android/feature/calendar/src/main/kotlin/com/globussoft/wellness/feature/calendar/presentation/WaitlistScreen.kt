package com.globussoft.wellness.feature.calendar.presentation

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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.LocalOffer
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.common.utils.formatDate
import com.globussoft.wellness.core.common.utils.formatRelativeTime
import com.globussoft.wellness.core.designsystem.components.ConfirmDialog
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.domain.model.WaitlistEntry
import com.globussoft.wellness.core.domain.model.WaitlistStatus
import com.globussoft.wellness.core.network.model.request.CreateWaitlistRequest

// ─── Waitlist screen state (local to this file) ───────────────────────────────

private data class WaitlistAddFormState(
    val patientName: String = "",
    val patientPhone: String = "",
    val serviceNote: String = "",
    val preferredDates: String = "",
    val estimatedWaitMinutes: String = "",
    val notes: String = "",
    val isSubmitting: Boolean = false,
    val error: String? = null,
)

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * Waitlist management screen reachable from the calendar.
 *
 * Shows a filterable list of waitlist entries with status chips and action buttons.
 * A ModalBottomSheet form allows adding new entries.
 *
 * The screen drives its data through [CalendarViewModel] (shared with
 * [CalendarScreen]) so the waitlist panel always reflects the same tenant scope
 * and the same `selectedLocationId` filter.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WaitlistScreen(
    viewModel: CalendarViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val bottomSheetState  = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var showAddForm by remember { mutableStateOf(false) }
    var selectedFilter by remember { mutableStateOf<String?>(null) }
    var cancelTarget by remember { mutableStateOf<WaitlistEntry?>(null) }

    LaunchedEffect(Unit) {
        // Ensure waitlist is loaded when navigating directly to this screen.
        viewModel.onEvent(CalendarEvent.Refresh)
        viewModel.effects.collect { effect ->
            when (effect) {
                is CalendarEffect.ShowSnackbar -> snackbarHostState.showSnackbar(effect.message)
                else                           -> Unit
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title  = { Text("Waitlist", fontWeight = FontWeight.Bold) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick        = { showAddForm = true },
                containerColor = WellnessPrimary,
                contentColor   = Color.White,
            ) {
                Icon(Icons.Filled.Add, contentDescription = "Add to waitlist")
            }
        },
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            // Status filter chips
            LazyRow(
                modifier            = Modifier.padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
            ) {
                val filters = listOf(null to "All") + WaitlistStatus.values().map { it.name to it.name.lowercase().replaceFirstChar { c -> c.uppercase() } }
                items(filters) { (key, label) ->
                    FilterChip(
                        selected = selectedFilter == key,
                        onClick  = { selectedFilter = key },
                        label    = { Text(label) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = WellnessPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }

            val filtered = if (selectedFilter == null) {
                state.waitlistEntries
            } else {
                state.waitlistEntries.filter { it.status.name == selectedFilter }
            }

            if (state.isLoading && filtered.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = WellnessPrimary)
                }
            } else if (filtered.isEmpty()) {
                EmptyState(
                    message = if (selectedFilter != null) "No waitlist entries with status $selectedFilter" else "No waitlist entries. Tap + to add a patient.",
                )
            } else {
                LazyColumn(
                    modifier            = Modifier.fillMaxSize(),
                    contentPadding      = androidx.compose.foundation.layout.PaddingValues(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                ) {
                    items(filtered, key = { it.id }) { entry ->
                        WaitlistEntryCard(
                            entry    = entry,
                            onOffer  = { viewModel.onEvent(CalendarEvent.ChangeVisitStatus(entry.id, "OFFERED")) },
                            onBook   = { viewModel.onEvent(CalendarEvent.OpenNewVisitModal(hour = null)) },
                            onCancel = { cancelTarget = entry },
                        )
                    }
                }
            }
        }
    }

    // Add to waitlist bottom sheet
    if (showAddForm) {
        ModalBottomSheet(
            onDismissRequest = { showAddForm = false },
            sheetState       = bottomSheetState,
        ) {
            AddWaitlistForm(
                services = state.services,
                onSubmit = { req ->
                    viewModel.onEvent(CalendarEvent.Refresh) // triggers reload after add
                    showAddForm = false
                },
                onDismiss = { showAddForm = false },
            )
        }
    }

    // Cancel confirmation dialog
    cancelTarget?.let { entry ->
        ConfirmDialog(
            title          = "Cancel Waitlist Entry",
            message        = "Remove ${entry.patientName ?: "this patient"} from the waitlist? This cannot be undone.",
            confirmLabel   = "Remove",
            isDestructive  = true,
            onConfirm      = {
                viewModel.onEvent(CalendarEvent.ChangeVisitStatus(entry.id, "CANCELLED"))
                cancelTarget = null
            },
            onDismiss      = { cancelTarget = null },
        )
    }
}

// ─── Waitlist entry card ──────────────────────────────────────────────────────

@Composable
private fun WaitlistEntryCard(
    entry: WaitlistEntry,
    onOffer: () -> Unit,
    onBook: () -> Unit,
    onCancel: () -> Unit,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
            val entryPatientPhone = entry.patientPhone
            val entryServiceName = entry.serviceName
            val entryPreferredDateRange = entry.preferredDateRange
            val entryNotes = entry.notes
            // Header row: name + status badge
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text       = entry.patientName ?: "Unknown Patient",
                        style      = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    if (!entryPatientPhone.isNullOrBlank()) {
                        Text(
                            text  = entryPatientPhone,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                StatusBadge(status = entry.status.name)
            }

            Spacer(Modifier.height(Dimens.SpacingSm))

            // Service
            if (!entryServiceName.isNullOrBlank()) {
                LabelValue("Service", entryServiceName)
            }

            // Preferred dates
            if (!entryPreferredDateRange.isNullOrBlank()) {
                LabelValue("Preferred Dates", entryPreferredDateRange)
            }

            // Estimated wait
            entry.estimatedWaitMin?.let { min ->
                LabelValue("Est. Wait", "$min min")
            }

            // Added date
            LabelValue("Added", formatRelativeTime(entry.createdAt ?: ""))

            // Offered at
            entry.offeredAt?.let {
                LabelValue("Offered At", formatDate(it))
            }

            // Notes
            if (!entryNotes.isNullOrBlank()) {
                LabelValue("Notes", entryNotes)
            }

            // Action buttons
            if (entry.status == WaitlistStatus.WAITING || entry.status == WaitlistStatus.OFFERED) {
                Spacer(Modifier.height(Dimens.SpacingMd))
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                ) {
                    if (entry.status == WaitlistStatus.WAITING) {
                        AssistChip(
                            onClick = onOffer,
                            label   = { Text("Offer Slot") },
                            leadingIcon = {
                                Icon(Icons.Filled.LocalOffer, contentDescription = null,
                                    modifier = Modifier.padding(4.dp))
                            },
                            colors = AssistChipDefaults.assistChipColors(
                                containerColor = WellnessPrimary.copy(alpha = 0.12f),
                                labelColor     = WellnessPrimary,
                            ),
                        )
                    }
                    AssistChip(
                        onClick = onBook,
                        label   = { Text("Book Now") },
                        leadingIcon = {
                            Icon(Icons.Filled.CheckCircle, contentDescription = null,
                                modifier = Modifier.padding(4.dp))
                        },
                        colors = AssistChipDefaults.assistChipColors(
                            containerColor = WellnessPrimary.copy(alpha = 0.12f),
                            labelColor     = WellnessPrimary,
                        ),
                    )
                    AssistChip(
                        onClick = onCancel,
                        label   = { Text("Cancel") },
                        leadingIcon = {
                            Icon(Icons.Filled.Block, contentDescription = null,
                                modifier = Modifier.padding(4.dp))
                        },
                        colors = AssistChipDefaults.assistChipColors(
                            containerColor = WellnessDanger.copy(alpha = 0.10f),
                            labelColor     = WellnessDanger,
                        ),
                    )
                }
            }
        }
    }
}

@Composable
private fun LabelValue(label: String, value: String) {
    Row(
        modifier              = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
    ) {
        Text(
            text  = "$label:",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text  = value,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

// ─── Add waitlist form ────────────────────────────────────────────────────────

@Composable
private fun AddWaitlistForm(
    services: List<com.globussoft.wellness.core.domain.model.Service>,
    onSubmit: (CreateWaitlistRequest) -> Unit,
    onDismiss: () -> Unit,
) {
    var formState by remember { mutableStateOf(WaitlistAddFormState()) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(Dimens.SpacingLg)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
    ) {
        Text(
            text       = "Add to Waitlist",
            style      = MaterialTheme.typography.titleLarge,
            color      = WellnessPrimary,
            fontWeight = FontWeight.Bold,
        )

        WellnessTextField(
            value         = formState.patientName,
            onValueChange = { formState = formState.copy(patientName = it) },
            label         = "Patient Name",
            modifier      = Modifier.fillMaxWidth(),
        )

        WellnessTextField(
            value         = formState.patientPhone,
            onValueChange = { formState = formState.copy(patientPhone = it) },
            label         = "Phone Number",
            modifier      = Modifier.fillMaxWidth(),
        )

        WellnessTextField(
            value         = formState.preferredDates,
            onValueChange = { formState = formState.copy(preferredDates = it) },
            label         = "Preferred Dates (e.g. 2026-06-01 to 2026-06-15)",
            modifier      = Modifier.fillMaxWidth(),
        )

        WellnessTextField(
            value         = formState.estimatedWaitMinutes,
            onValueChange = { formState = formState.copy(estimatedWaitMinutes = it) },
            label         = "Estimated Wait (minutes, optional)",
            modifier      = Modifier.fillMaxWidth(),
        )

        WellnessTextField(
            value         = formState.notes,
            onValueChange = { formState = formState.copy(notes = it) },
            label         = "Notes (optional)",
            singleLine    = false,
            maxLines      = 3,
            modifier      = Modifier.fillMaxWidth(),
        )

        if (!formState.error.isNullOrBlank()) {
            Text(formState.error!!, color = WellnessDanger, style = MaterialTheme.typography.labelSmall)
        }

        Row(
            modifier              = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            TextButton(
                onClick  = onDismiss,
                modifier = Modifier.weight(1f),
            ) {
                Text("Cancel")
            }
            WellnessButton(
                text     = if (formState.isSubmitting) "Adding…" else "Add to Waitlist",
                onClick  = {
                    if (formState.patientName.isBlank()) {
                        formState = formState.copy(error = "Patient name is required")
                        return@WellnessButton
                    }
                    val req = CreateWaitlistRequest(
                        patientId          = "",     // resolved server-side via name+phone for new patients
                        serviceId          = "",
                        preferredDateRange = formState.preferredDates.ifBlank { null },
                        estimatedWaitMin   = formState.estimatedWaitMinutes.toIntOrNull(),
                        notes              = formState.notes.ifBlank { null },
                    )
                    formState = formState.copy(isSubmitting = true)
                    onSubmit(req)
                },
                enabled  = !formState.isSubmitting,
                modifier = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(Dimens.SpacingXl))
    }
}
