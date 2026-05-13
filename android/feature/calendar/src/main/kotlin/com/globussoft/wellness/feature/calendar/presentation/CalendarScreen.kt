package com.globussoft.wellness.feature.calendar.presentation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LocalHospital
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Today
import androidx.compose.material.icons.filled.VideoCall
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.common.utils.formatTimeOnly
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessAvatar
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessBorderColor
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.core.designsystem.theme.WellnessWarning
import com.globussoft.wellness.core.domain.model.BookingType
import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.core.domain.model.Service
import com.globussoft.wellness.core.domain.model.Staff
import com.globussoft.wellness.core.domain.model.Visit
import com.globussoft.wellness.core.domain.model.VisitStatus
import com.globussoft.wellness.core.domain.model.WaitlistEntry
import java.time.LocalDate
import java.time.format.DateTimeFormatter

// ─── Hour slot height constant ────────────────────────────────────────────────

private val HOUR_SLOT_HEIGHT = 64.dp
private val PRACTITIONER_COL_WIDTH = 180.dp
private val TIME_COL_WIDTH = 56.dp

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * Day-grid calendar screen showing practitioner columns with visit cards.
 *
 * ### Layout
 * ```
 * TopAppBar: ← Today → | Date | "Show All" toggle | Location picker
 * (Optional) Holiday banner
 * ─────────────────────────────────────────────────────────────
 * Time │ Dr. Harsh      │ Dr. Anjali     │ … │ Unassigned
 *  09  │ [visit card]   │                │   │
 *  10  │                │ [visit card]   │   │
 *  …
 * ─────────────────────────────────────────────────────────────
 * FAB (+) → opens NewVisitModal
 * ```
 *
 * @param viewModel          HiltViewModel for the calendar.
 * @param onNavigateToPatient Called when the user taps a visit card to open
 *                           the patient detail screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarScreen(
    viewModel: CalendarViewModel = hiltViewModel(),
    onNavigateToPatient: (String) -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val bottomSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Consume one-shot effects.
    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is CalendarEffect.NavigateToPatient -> onNavigateToPatient(effect.patientId)
                is CalendarEffect.ShowSnackbar      -> snackbarHostState.showSnackbar(effect.message)
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            CalendarTopBar(
                selectedDate         = state.selectedDate,
                showAllPractitioners = state.showAllPractitioners,
                locations            = state.locations,
                selectedLocationId   = state.selectedLocationId,
                onEvent              = viewModel::onEvent,
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick            = { viewModel.onEvent(CalendarEvent.OpenNewVisitModal()) },
                containerColor     = WellnessPrimary,
                contentColor       = Color.White,
            ) {
                Icon(Icons.Filled.Add, contentDescription = "New visit")
            }
        },
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            // Holiday banner
            if (!state.holidayName.isNullOrBlank()) {
                HolidayBanner(name = state.holidayName!!)
            }

            if (state.isLoading && state.visits.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = WellnessPrimary)
                }
            } else if (!state.error.isNullOrBlank() && state.visits.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(state.error!!, color = WellnessDanger)
                        Spacer(Modifier.height(Dimens.SpacingMd))
                        TextButton(onClick = { viewModel.onEvent(CalendarEvent.Refresh) }) {
                            Text("Retry")
                        }
                    }
                }
            } else {
                CalendarDayGrid(
                    state           = state,
                    onEvent         = viewModel::onEvent,
                    onNavigateToPatient = onNavigateToPatient,
                )
            }
        }
    }

    // New visit bottom sheet
    if (state.newVisitModal != null) {
        ModalBottomSheet(
            onDismissRequest = { viewModel.onEvent(CalendarEvent.CloseNewVisitModal) },
            sheetState       = bottomSheetState,
        ) {
            NewVisitModal(
                modalState = state.newVisitModal!!,
                staff      = state.staff,
                services   = state.services,
                waitlist   = state.waitlistEntries,
                onEvent    = viewModel::onEvent,
            )
        }
    }
}

// ─── Top bar ──────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CalendarTopBar(
    selectedDate: LocalDate,
    showAllPractitioners: Boolean,
    locations: List<Location>,
    selectedLocationId: String?,
    onEvent: (CalendarEvent) -> Unit,
) {
    var showLocationMenu by remember { mutableStateOf(false) }

    TopAppBar(
        title = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
            ) {
                IconButton(onClick = { onEvent(CalendarEvent.PreviousDay) }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Previous day")
                }
                TextButton(onClick = { onEvent(CalendarEvent.Today) }) {
                    Icon(Icons.Filled.Today, contentDescription = null, tint = WellnessPrimary)
                    Spacer(Modifier.width(4.dp))
                    Text("Today", color = WellnessPrimary)
                }
                IconButton(onClick = { onEvent(CalendarEvent.NextDay) }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = "Next day")
                }
                Text(
                    text = selectedDate.format(
                        DateTimeFormatter.ofPattern("EEE, d MMM yyyy"),
                    ),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = WellnessPrimary,
                )
            }
        },
        actions = {
            // Show All toggle chip
            FilterChip(
                selected = showAllPractitioners,
                onClick  = { onEvent(CalendarEvent.ToggleShowAll) },
                label    = { Text("Show All", fontSize = 12.sp) },
                colors   = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = WellnessPrimary,
                    selectedLabelColor     = Color.White,
                ),
                modifier = Modifier.padding(end = Dimens.SpacingSm),
            )

            // Location picker
            if (locations.isNotEmpty()) {
                Box {
                    TextButton(onClick = { showLocationMenu = true }) {
                        val label = locations.find { it.id == selectedLocationId }?.name ?: "All Locations"
                        Text(label, fontSize = 12.sp, color = WellnessPrimary)
                    }
                    DropdownMenu(
                        expanded         = showLocationMenu,
                        onDismissRequest = { showLocationMenu = false },
                    ) {
                        DropdownMenuItem(
                            text    = { Text("All Locations") },
                            onClick = {
                                onEvent(CalendarEvent.SelectLocation(null))
                                showLocationMenu = false
                            },
                        )
                        locations.forEach { loc ->
                            DropdownMenuItem(
                                text    = { Text(loc.name) },
                                onClick = {
                                    onEvent(CalendarEvent.SelectLocation(loc.id))
                                    showLocationMenu = false
                                },
                            )
                        }
                    }
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
    )
}

// ─── Holiday banner ───────────────────────────────────────────────────────────

@Composable
private fun HolidayBanner(name: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(WellnessWarning.copy(alpha = 0.12f))
            .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
    ) {
        Icon(Icons.Filled.Warning, contentDescription = null, tint = WellnessWarning, modifier = Modifier.size(16.dp))
        Text(
            text = "Holiday: $name",
            style = MaterialTheme.typography.labelMedium,
            color = WellnessWarning,
        )
    }
}

// ─── Day grid ─────────────────────────────────────────────────────────────────

@Composable
private fun CalendarDayGrid(
    state: CalendarUiState,
    onEvent: (CalendarEvent) -> Unit,
    onNavigateToPatient: (String) -> Unit,
) {
    // Determine time range: min(9, earliest visit hour) to max(19, latest+1)
    val visitHours = state.visits.mapNotNull { visit ->
        runCatching {
            visit.visitDate.substring(11, 13).toInt()
        }.getOrNull()
    }
    val startHour = if (visitHours.isEmpty()) 9 else minOf(9, visitHours.min())
    val endHour   = if (visitHours.isEmpty()) 19 else maxOf(19, visitHours.max() + 1)
    val totalHours = endHour - startHour

    // Determine visible practitioners
    val visibleStaff = if (state.showAllPractitioners) {
        state.staff
    } else {
        val doctorIdsWithVisits = state.visits.mapNotNull { it.doctorId }.toSet()
        state.staff.filter { it.id in doctorIdsWithVisits }
    }

    val unassignedVisits = state.visits.filter { it.doctorId == null }

    val horizontalScroll = rememberScrollState()
    val verticalScroll   = rememberScrollState()

    // Sticky header row: time column + practitioner columns
    Column(modifier = Modifier.fillMaxSize()) {
        // Header row (practitioner names)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(horizontalScroll)
                .background(MaterialTheme.colorScheme.surface)
                .border(width = 0.5.dp, color = WellnessBorderColor),
        ) {
            // Time column header (empty)
            Box(
                modifier = Modifier
                    .width(TIME_COL_WIDTH)
                    .height(56.dp)
                    .border(width = 0.5.dp, color = WellnessBorderColor),
            )
            visibleStaff.forEach { staff ->
                PractitionerColumnHeader(staff = staff)
            }
            if (unassignedVisits.isNotEmpty()) {
                Box(
                    modifier = Modifier
                        .width(PRACTITIONER_COL_WIDTH)
                        .height(56.dp)
                        .border(0.5.dp, WellnessBorderColor)
                        .padding(horizontal = Dimens.SpacingSm),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text  = "Unassigned",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        // Scrollable body: time column + visit grid
        Row(
            modifier = Modifier
                .fillMaxSize()
                .horizontalScroll(horizontalScroll)
                .verticalScroll(verticalScroll),
        ) {
            // Time labels column
            Column(modifier = Modifier.width(TIME_COL_WIDTH)) {
                repeat(totalHours) { offset ->
                    val hour = startHour + offset
                    Box(
                        modifier = Modifier
                            .width(TIME_COL_WIDTH)
                            .height(HOUR_SLOT_HEIGHT)
                            .border(0.5.dp, WellnessBorderColor),
                        contentAlignment = Alignment.TopCenter,
                    ) {
                        Text(
                            text     = "%02d:00".format(hour),
                            style    = MaterialTheme.typography.labelSmall,
                            color    = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }
            }

            // Practitioner columns
            visibleStaff.forEach { staff ->
                val staffVisits = state.visits.filter { it.doctorId == staff.id }
                PractitionerColumn(
                    staff      = staff,
                    visits     = staffVisits,
                    startHour  = startHour,
                    totalHours = totalHours,
                    onVisitClick = { visit ->
                        onNavigateToPatient(visit.patientId)
                    },
                    onStatusChange = { visit, newStatus ->
                        onEvent(CalendarEvent.ChangeVisitStatus(visit.id, newStatus))
                    },
                    onEmptySlotClick = { hour ->
                        onEvent(CalendarEvent.OpenNewVisitModal(doctorId = staff.id, hour = hour))
                    },
                )
            }

            // Unassigned column
            if (unassignedVisits.isNotEmpty()) {
                PractitionerColumn(
                    staff      = null,
                    visits     = unassignedVisits,
                    startHour  = startHour,
                    totalHours = totalHours,
                    onVisitClick = { visit ->
                        onNavigateToPatient(visit.patientId)
                    },
                    onStatusChange = { visit, newStatus ->
                        onEvent(CalendarEvent.ChangeVisitStatus(visit.id, newStatus))
                    },
                    onEmptySlotClick = {},
                )
            }
        }
    }

    // Status legend strip
    StatusLegend()
}

// ─── Practitioner column header ───────────────────────────────────────────────

@Composable
private fun PractitionerColumnHeader(staff: Staff) {
    Row(
        modifier = Modifier
            .width(PRACTITIONER_COL_WIDTH)
            .height(56.dp)
            .border(0.5.dp, WellnessBorderColor)
            .padding(horizontal = Dimens.SpacingSm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
    ) {
        WellnessAvatar(name = staff.name, size = 32.dp)
        Text(
            text     = staff.name,
            style    = MaterialTheme.typography.labelMedium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

// ─── Practitioner column body ─────────────────────────────────────────────────

@Composable
private fun PractitionerColumn(
    staff: Staff?,
    visits: List<Visit>,
    startHour: Int,
    totalHours: Int,
    onVisitClick: (Visit) -> Unit,
    onStatusChange: (Visit, String) -> Unit,
    onEmptySlotClick: (Int) -> Unit,
) {
    Box(
        modifier = Modifier
            .width(PRACTITIONER_COL_WIDTH)
            .height((totalHours * HOUR_SLOT_HEIGHT.value).dp),
    ) {
        // Hour slot backgrounds (clickable empty slots)
        Column {
            repeat(totalHours) { offset ->
                val hour = startHour + offset
                Box(
                    modifier = Modifier
                        .width(PRACTITIONER_COL_WIDTH)
                        .height(HOUR_SLOT_HEIGHT)
                        .border(0.5.dp, WellnessBorderColor)
                        .clickable(enabled = staff != null) { onEmptySlotClick(hour) },
                )
            }
        }

        // Visit cards overlaid with absolute positioning
        visits.forEach { visit ->
            val visitHour = runCatching {
                visit.visitDate.substring(11, 13).toInt()
            }.getOrDefault(startHour)
            val topOffset = ((visitHour - startHour) * HOUR_SLOT_HEIGHT.value).dp

            VisitCard(
                visit          = visit,
                onClick        = { onVisitClick(visit) },
                onStatusChange = { newStatus -> onStatusChange(visit, newStatus) },
                modifier       = Modifier
                    .offset(y = topOffset)
                    .width(PRACTITIONER_COL_WIDTH - 4.dp)
                    .padding(horizontal = 2.dp),
            )
        }
    }
}

// ─── Visit card ───────────────────────────────────────────────────────────────

@Composable
private fun VisitCard(
    visit: Visit,
    onClick: () -> Unit,
    onStatusChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var showStatusMenu by remember { mutableStateOf(false) }

    val borderColor = when (visit.status) {
        VisitStatus.BOOKED,
        VisitStatus.CONFIRMED  -> WellnessPrimary
        VisitStatus.ARRIVED,
        VisitStatus.IN_TREATMENT -> WellnessWarning
        VisitStatus.COMPLETED  -> WellnessSuccess
        VisitStatus.NO_SHOW,
        VisitStatus.CANCELLED  -> WellnessDanger
    }

    Column(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.92f))
            .border(
                width = 2.dp,
                color = borderColor,
                shape = RoundedCornerShape(6.dp),
            )
            .clickable { onClick() }
            .padding(horizontal = 6.dp, vertical = 4.dp),
    ) {
        // Patient name + booking-type icon
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(
                imageVector        = visit.bookingType.toIcon(),
                contentDescription = visit.bookingType.name,
                tint               = WellnessPrimary,
                modifier           = Modifier.size(12.dp),
            )
            Text(
                text     = visit.patientName ?: "Unknown",
                style    = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        // Service name
        if (!visit.serviceName.isNullOrBlank()) {
            Text(
                text     = visit.serviceName,
                style    = MaterialTheme.typography.labelSmall,
                color    = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        // Time + status badge
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                text  = formatTimeOnly(visit.visitDate),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Box {
                StatusBadge(
                    status   = visit.status.name,
                    modifier = Modifier.clickable { showStatusMenu = true },
                )
                DropdownMenu(
                    expanded         = showStatusMenu,
                    onDismissRequest = { showStatusMenu = false },
                ) {
                    listOf(
                        "CONFIRMED", "ARRIVED", "IN_TREATMENT",
                        "COMPLETED", "NO_SHOW", "CANCELLED",
                    ).forEach { s ->
                        DropdownMenuItem(
                            text    = { Text(s.replace('_', ' '), fontSize = 12.sp) },
                            onClick = {
                                onStatusChange(s)
                                showStatusMenu = false
                            },
                        )
                    }
                }
            }
        }
    }
}

// ─── Status legend ────────────────────────────────────────────────────────────

@Composable
private fun StatusLegend() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm)
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
    ) {
        val statuses = listOf(
            "BOOKED", "CONFIRMED", "ARRIVED", "IN_TREATMENT",
            "COMPLETED", "NO_SHOW", "CANCELLED",
        )
        statuses.forEach { s ->
            StatusBadge(status = s)
        }
    }
}

// ─── New visit modal ──────────────────────────────────────────────────────────

@Composable
private fun NewVisitModal(
    modalState: NewVisitModalState,
    staff: List<Staff>,
    services: List<Service>,
    waitlist: List<WaitlistEntry>,
    onEvent: (CalendarEvent) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(Dimens.SpacingLg)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
    ) {
        Text(
            text  = "New Visit",
            style = MaterialTheme.typography.titleLarge,
            color = WellnessPrimary,
            fontWeight = FontWeight.Bold,
        )

        // New patient / from waitlist toggle
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        ) {
            FilterChip(
                selected = modalState.isNewPatient,
                onClick  = { onEvent(CalendarEvent.ModalFieldChanged("isNewPatient", "true")) },
                label    = { Text("New Patient") },
                colors   = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = WellnessPrimary,
                    selectedLabelColor     = Color.White,
                ),
                modifier = Modifier.weight(1f),
            )
            FilterChip(
                selected = !modalState.isNewPatient,
                onClick  = { onEvent(CalendarEvent.ModalFieldChanged("isNewPatient", "false")) },
                label    = { Text("From Waitlist") },
                colors   = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = WellnessPrimary,
                    selectedLabelColor     = Color.White,
                ),
                modifier = Modifier.weight(1f),
            )
        }

        if (modalState.isNewPatient) {
            WellnessTextField(
                value         = modalState.patientName,
                onValueChange = { onEvent(CalendarEvent.ModalFieldChanged("patientName", it)) },
                label         = "Patient Name",
                modifier      = Modifier.fillMaxWidth(),
            )
            WellnessTextField(
                value         = modalState.patientPhone,
                onValueChange = { onEvent(CalendarEvent.ModalFieldChanged("patientPhone", it)) },
                label         = "Phone Number",
                modifier      = Modifier.fillMaxWidth(),
            )
        } else {
            // Waitlist dropdown
            var showWaitlistMenu by remember { mutableStateOf(false) }
            val selectedEntry = waitlist.find { it.id == modalState.fromWaitlistId }
            Box {
                WellnessTextField(
                    value         = selectedEntry?.patientName ?: "Select waitlist patient",
                    onValueChange = {},
                    label         = "From Waitlist",
                    readOnly      = true,
                    modifier      = Modifier
                        .fillMaxWidth()
                        .clickable { showWaitlistMenu = true },
                )
                DropdownMenu(
                    expanded         = showWaitlistMenu,
                    onDismissRequest = { showWaitlistMenu = false },
                ) {
                    waitlist.filter { it.status.name == "WAITING" || it.status.name == "OFFERED" }
                        .forEach { entry ->
                            DropdownMenuItem(
                                text = {
                                    Column {
                                        Text(entry.patientName ?: "Unknown", fontWeight = FontWeight.Medium)
                                        Text(
                                            entry.serviceName ?: "",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                },
                                onClick = {
                                    onEvent(CalendarEvent.ModalFieldChanged("fromWaitlistId", entry.id))
                                    onEvent(CalendarEvent.ModalFieldChanged("patientId", entry.patientId))
                                    entry.serviceId?.let { onEvent(CalendarEvent.ModalFieldChanged("serviceId", it)) }
                                    showWaitlistMenu = false
                                },
                            )
                        }
                }
            }
        }

        // Service dropdown
        ModalDropdown(
            label       = "Service",
            selected    = services.find { it.id == modalState.selectedServiceId }?.name ?: "",
            placeholder = "Select service",
            items       = services.map { it.id to it.name },
            onSelect    = { id -> onEvent(CalendarEvent.ModalFieldChanged("serviceId", id)) },
        )

        // Doctor dropdown
        ModalDropdown(
            label       = "Doctor / Professional",
            selected    = staff.find { it.id == modalState.selectedDoctorId }?.name ?: "",
            placeholder = "Select doctor",
            items       = staff.map { it.id to it.name },
            onSelect    = { id -> onEvent(CalendarEvent.ModalFieldChanged("doctorId", id)) },
        )

        // Booking type chips
        Text(
            text  = "Booking Type",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        ) {
            listOf(
                "CLINIC_VISIT" to "Clinic",
                "AT_HOME"      to "Home",
                "VIDEO"        to "Video",
                "PHONE"        to "Phone",
            ).forEach { (type, label) ->
                FilterChip(
                    selected = modalState.bookingType == type,
                    onClick  = { onEvent(CalendarEvent.ModalFieldChanged("bookingType", type)) },
                    label    = { Text(label, fontSize = 12.sp) },
                    colors   = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = WellnessPrimary,
                        selectedLabelColor     = Color.White,
                    ),
                )
            }
        }

        // Notes
        WellnessTextField(
            value         = modalState.notes,
            onValueChange = { onEvent(CalendarEvent.ModalFieldChanged("notes", it)) },
            label         = "Notes (optional)",
            singleLine    = false,
            maxLines      = 3,
            modifier      = Modifier.fillMaxWidth(),
        )

        // Error
        if (!modalState.error.isNullOrBlank()) {
            Text(
                text  = modalState.error,
                color = WellnessDanger,
                style = MaterialTheme.typography.labelSmall,
            )
        }

        // Submit
        WellnessButton(
            text      = if (modalState.isSubmitting) "Booking…" else "Book Visit",
            onClick   = { onEvent(CalendarEvent.SubmitNewVisit) },
            enabled   = !modalState.isSubmitting,
            modifier  = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(Dimens.SpacingXl))
    }
}

// ─── Generic modal dropdown helper ───────────────────────────────────────────

@Composable
private fun ModalDropdown(
    label: String,
    selected: String,
    placeholder: String,
    items: List<Pair<String, String>>,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        WellnessTextField(
            value         = selected.ifBlank { placeholder },
            onValueChange = {},
            label         = label,
            readOnly      = true,
            modifier      = Modifier
                .fillMaxWidth()
                .clickable { expanded = true },
        )
        DropdownMenu(
            expanded         = expanded,
            onDismissRequest = { expanded = false },
        ) {
            items.forEach { (id, name) ->
                DropdownMenuItem(
                    text    = { Text(name) },
                    onClick = {
                        onSelect(id)
                        expanded = false
                    },
                )
            }
        }
    }
}

// ─── BookingType → Icon ───────────────────────────────────────────────────────

private fun BookingType.toIcon(): ImageVector = when (this) {
    BookingType.CLINIC_VISIT -> Icons.Filled.LocalHospital
    BookingType.AT_HOME      -> Icons.Filled.Home
    BookingType.VIDEO        -> Icons.Filled.VideoCall
    BookingType.PHONE        -> Icons.Filled.Phone
}
