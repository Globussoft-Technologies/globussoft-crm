package com.globussoft.wellness.feature.services.presentation

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
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
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.ConfirmDialog
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessTabStrip
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.core.designsystem.theme.WellnessWarning
import com.globussoft.wellness.core.domain.model.Service
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * Services catalog screen with a three-tab HorizontalPager layout.
 *
 * ### Tab 0 — Catalog
 * A responsive `LazyVerticalGrid(GridCells.Adaptive(280.dp))` of service cards.
 * Each card shows the service name, category badge, price in ₹, duration,
 * and ticket tier. Edit and Delete icon buttons are visible in the card actions.
 * Tapping "Add Service" in the top bar opens the add/edit bottom sheet.
 *
 * ### Tab 1 — Packages
 * Static placeholder. Package configuration requires a separate admin flow
 * (bundle pricing endpoints not yet in scope).
 *
 * ### Tab 2 — Active Treatments
 * Placeholder list. Treatment plan data would be fetched from the Patients
 * module in a future iteration.
 *
 * @param viewModel HiltViewModel for the services feature.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServicesScreen(
    viewModel: ServicesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val pagerState = rememberPagerState(
        initialPage  = state.selectedTabIndex,
        pageCount    = { 3 },
    )
    val bottomSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Sync pager with ViewModel tab state.
    LaunchedEffect(state.selectedTabIndex) {
        if (pagerState.currentPage != state.selectedTabIndex) {
            pagerState.animateScrollToPage(state.selectedTabIndex)
        }
    }
    LaunchedEffect(pagerState.currentPage) {
        if (pagerState.currentPage != state.selectedTabIndex) {
            viewModel.onEvent(ServicesEvent.TabSelected(pagerState.currentPage))
        }
    }

    // Consume one-shot effects.
    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is ServicesEffect.ShowSnackbar -> snackbarHostState.showSnackbar(effect.message)
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title  = {
                    Text(
                        text       = "Services",
                        fontWeight = FontWeight.Bold,
                        color      = WellnessPrimary,
                    )
                },
                actions = {
                    FilledTonalButton(
                        onClick  = { viewModel.onEvent(ServicesEvent.ToggleAddForm) },
                        modifier = Modifier.padding(end = Dimens.SpacingMd),
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.size(4.dp))
                        Text("Add Service", fontSize = 13.sp)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            WellnessTabStrip(
                tabs          = listOf("Catalog", "Packages", "Active Treatments"),
                selectedIndex = state.selectedTabIndex,
                onTabSelected = { viewModel.onEvent(ServicesEvent.TabSelected(it)) },
            )

            if (state.isLoading && state.services.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = WellnessPrimary)
                }
            } else {
                HorizontalPager(
                    state    = pagerState,
                    modifier = Modifier.fillMaxSize(),
                ) { page ->
                    when (page) {
                        0    -> CatalogTab(
                            services = state.services,
                            onEdit   = { viewModel.onEvent(ServicesEvent.EditService(it)) },
                            onDelete = { viewModel.onEvent(ServicesEvent.DeleteRequested(it)) },
                        )
                        1    -> PackagesTab(services = state.services)
                        else -> ActiveTreatmentsTab(
                            plans            = state.treatmentPlans,
                            isLoading        = state.isLoadingTreatments,
                            error            = state.treatmentPlansError,
                            onTogglePause    = { viewModel.onEvent(ServicesEvent.ToggleTreatmentPause(it)) },
                            onCancel         = { viewModel.onEvent(ServicesEvent.CancelTreatment(it)) },
                        )
                    }
                }
            }
        }
    }

    // Add / Edit bottom sheet
    if (state.showAddForm) {
        ModalBottomSheet(
            onDismissRequest = { viewModel.onEvent(ServicesEvent.ToggleAddForm) },
            sheetState       = bottomSheetState,
        ) {
            ServiceFormSheet(
                formState      = state.formState,
                isEditing      = state.editingService != null,
                onFieldChanged = { field, value -> viewModel.onEvent(ServicesEvent.FormFieldChanged(field, value)) },
                onSubmit       = { viewModel.onEvent(ServicesEvent.SubmitForm) },
                onDismiss      = { viewModel.onEvent(ServicesEvent.ToggleAddForm) },
            )
        }
    }

    // Delete confirm dialog
    state.deleteConfirmService?.let { svc ->
        ConfirmDialog(
            title          = "Delete Service",
            message        = "Delete \"${svc.name}\"? Historical visit records referencing this service will be preserved.",
            confirmLabel   = "Delete",
            isDestructive  = true,
            onConfirm      = { viewModel.onEvent(ServicesEvent.ConfirmDelete) },
            onDismiss      = { viewModel.onEvent(ServicesEvent.DismissDelete) },
        )
    }
}

// ─── Catalog tab ──────────────────────────────────────────────────────────────

@Composable
private fun CatalogTab(
    services: List<Service>,
    onEdit: (Service) -> Unit,
    onDelete: (Service) -> Unit,
) {
    if (services.isEmpty()) {
        EmptyState(
            message = "No services yet. Tap \"Add Service\" to create your first service.",
        )
        return
    }

    LazyVerticalGrid(
        columns             = GridCells.Adaptive(minSize = 280.dp),
        modifier            = Modifier
            .fillMaxSize()
            .padding(Dimens.SpacingLg),
        verticalArrangement   = Arrangement.spacedBy(Dimens.SpacingMd),
        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
    ) {
        items(services, key = { it.id }) { service ->
            ServiceCatalogCard(
                service  = service,
                onEdit   = { onEdit(service) },
                onDelete = { onDelete(service) },
            )
        }
    }
}

@Composable
private fun ServiceCatalogCard(
    service: Service,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
            // Name + edit/delete icons
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text       = service.name,
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    modifier   = Modifier.weight(1f),
                )
                Row {
                    IconButton(onClick = onEdit, modifier = Modifier.size(32.dp)) {
                        Icon(
                            Icons.Filled.Edit,
                            contentDescription = "Edit",
                            tint               = WellnessPrimary,
                            modifier           = Modifier.size(16.dp),
                        )
                    }
                    IconButton(onClick = onDelete, modifier = Modifier.size(32.dp)) {
                        Icon(
                            Icons.Filled.Delete,
                            contentDescription = "Delete",
                            tint               = WellnessDanger,
                            modifier           = Modifier.size(16.dp),
                        )
                    }
                }
            }

            Spacer(Modifier.height(Dimens.SpacingSm))

            // Badges row: category + ticket tier + active/inactive
            val serviceCategory = service.category
            val serviceTicketTier = service.ticketTier
            Row(
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                if (!serviceCategory.isNullOrBlank()) {
                    StatusBadge(status = serviceCategory)
                }
                if (!serviceTicketTier.isNullOrBlank()) {
                    StatusBadge(status = serviceTicketTier)
                }
                StatusBadge(status = if (service.isActive) "COMPLETED" else "CANCELLED")
            }

            Spacer(Modifier.height(Dimens.SpacingSm))

            // Price + duration
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingLg),
            ) {
                LabelValue(
                    label = "Price",
                    value = "₹${service.basePrice.toLong()}",
                )
                LabelValue(
                    label = "Duration",
                    value = "${service.durationMin} min",
                )
            }

            // Description
            val serviceDescription = service.description
            if (!serviceDescription.isNullOrBlank()) {
                Spacer(Modifier.height(Dimens.SpacingXs))
                Text(
                    text     = serviceDescription,
                    style    = MaterialTheme.typography.bodySmall,
                    color    = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                )
            }

            // Target radius for home services
            service.targetRadiusKm?.let { radius ->
                Spacer(Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = "Home delivery within ${radius.toInt()} km",
                    style = MaterialTheme.typography.labelSmall,
                    color = WellnessPrimary,
                )
            }
        }
    }
}

@Composable
private fun LabelValue(label: String, value: String) {
    Column {
        Text(
            text  = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text       = value,
            style      = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            color      = WellnessPrimary,
        )
    }
}

// ─── Packages tab (bundle pricing builder) ────────────────────────────────────

@Composable
private fun PackagesTab(services: List<Service>) {
    if (services.isEmpty()) {
        EmptyState(message = "Load the service catalog first to build packages.")
        return
    }

    val sorted = remember(services) {
        services.sortedWith(
            compareByDescending<Service> { it.ticketTier == "high" }
                .thenByDescending { it.ticketTier == "medium" }
                .thenBy { it.name }
        )
    }

    var selectedService by remember { mutableStateOf(sorted.first()) }
    var sessions        by remember { mutableFloatStateOf(6f) }
    var discount        by remember { mutableFloatStateOf(15f) }
    var serviceDropdownExpanded by remember { mutableStateOf(false) }
    var copyLabel       by remember { mutableStateOf("Copy Pitch") }

    val sessionsInt  = sessions.toInt()
    val discountInt  = discount.toInt()
    val gross        = selectedService.basePrice * sessionsInt
    val savings      = (gross * discountInt / 100.0).toLong()
    val net          = gross.toLong() - savings
    val pitch        = "${selectedService.name} × $sessionsInt sessions = ₹$net ($discountInt% off)"

    val clipboardManager = LocalClipboardManager.current
    val scope            = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(Dimens.SpacingLg)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingLg),
    ) {
        Text(
            text       = "Bundle Pricing Builder",
            style      = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            color      = WellnessPrimary,
        )

        WellnessCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier            = Modifier.padding(Dimens.SpacingLg),
                verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                Text(
                    text  = "Service",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Box(modifier = Modifier.fillMaxWidth()) {
                    WellnessTextField(
                        value         = selectedService.name,
                        onValueChange = {},
                        label         = "Select Service",
                        readOnly      = true,
                        modifier      = Modifier.fillMaxWidth(),
                        trailingIcon  = {
                            IconButton(onClick = { serviceDropdownExpanded = true }) {
                                Icon(
                                    imageVector        = Icons.Filled.Edit,
                                    contentDescription = "Choose service",
                                    modifier           = Modifier.size(16.dp),
                                )
                            }
                        },
                    )
                    Box(
                        modifier = Modifier
                            .matchParentSize()
                            .clickable { serviceDropdownExpanded = true },
                    )
                    DropdownMenu(
                        expanded         = serviceDropdownExpanded,
                        onDismissRequest = { serviceDropdownExpanded = false },
                    ) {
                        sorted.forEach { svc ->
                            DropdownMenuItem(
                                text    = { Text("${svc.name} — ₹${svc.basePrice.toLong()}") },
                                onClick = {
                                    selectedService = svc
                                    serviceDropdownExpanded = false
                                },
                            )
                        }
                    }
                }

                Text(
                    text  = "Sessions: $sessionsInt",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Slider(
                    value         = sessions,
                    onValueChange = { sessions = it },
                    valueRange    = 2f..12f,
                    steps         = 9,
                    colors        = SliderDefaults.colors(thumbColor = WellnessPrimary, activeTrackColor = WellnessPrimary),
                )

                Text(
                    text  = "Discount: $discountInt%",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Slider(
                    value         = discount,
                    onValueChange = { discount = it },
                    valueRange    = 0f..50f,
                    steps         = 49,
                    colors        = SliderDefaults.colors(thumbColor = WellnessPrimary, activeTrackColor = WellnessPrimary),
                )
            }
        }

        WellnessCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier            = Modifier.padding(Dimens.SpacingLg),
                verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
            ) {
                Text(
                    text       = selectedService.name,
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color      = WellnessPrimary,
                )
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text  = "Sessions",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text  = "$sessionsInt",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text           = "Gross Price",
                        style          = MaterialTheme.typography.bodySmall,
                        color          = MaterialTheme.colorScheme.onSurfaceVariant,
                        textDecoration = TextDecoration.LineThrough,
                    )
                    Text(
                        text           = "₹${gross.toLong()}",
                        style          = MaterialTheme.typography.bodySmall,
                        color          = MaterialTheme.colorScheme.onSurfaceVariant,
                        textDecoration = TextDecoration.LineThrough,
                    )
                }
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text  = "Discount",
                        style = MaterialTheme.typography.bodySmall,
                        color = WellnessDanger,
                    )
                    Text(
                        text  = "-₹$savings",
                        style = MaterialTheme.typography.bodySmall,
                        color = WellnessDanger,
                    )
                }
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text       = "Net Price",
                        style      = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                        color      = WellnessPrimary,
                    )
                    Text(
                        text       = "₹$net",
                        style      = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                        color      = WellnessPrimary,
                    )
                }

                Spacer(Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = pitch,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(Dimens.SpacingXs))
                WellnessButton(
                    text     = copyLabel,
                    onClick  = {
                        clipboardManager.setText(AnnotatedString(pitch))
                        copyLabel = "Copied ✓"
                        scope.launch {
                            delay(2_000)
                            copyLabel = "Copy Pitch"
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

// ─── Active treatments tab ────────────────────────────────────────────────────

@Composable
private fun ActiveTreatmentsTab(
    plans: List<TreatmentPlan>,
    isLoading: Boolean,
    error: String?,
    onTogglePause: (TreatmentPlan) -> Unit,
    onCancel: (TreatmentPlan) -> Unit,
) {
    when {
        isLoading -> ShimmerList(itemCount = 4, modifier = Modifier.padding(Dimens.SpacingLg))
        error != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                text  = error,
                style = MaterialTheme.typography.bodyMedium,
                color = WellnessDanger,
            )
        }
        plans.isEmpty() -> EmptyState(message = "No active treatment plans found.")
        else -> LazyVerticalGrid(
            columns               = GridCells.Adaptive(minSize = 280.dp),
            modifier              = Modifier
                .fillMaxSize()
                .padding(Dimens.SpacingLg),
            verticalArrangement   = Arrangement.spacedBy(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            items(plans, key = { it.id }) { plan ->
                TreatmentPlanCard(
                    plan          = plan,
                    onTogglePause = { onTogglePause(plan) },
                    onCancel      = { onCancel(plan) },
                )
            }
        }
    }
}

@Composable
private fun TreatmentPlanCard(
    plan: TreatmentPlan,
    onTogglePause: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val progress = if (plan.totalSessions > 0) {
        plan.completedSessions.toFloat() / plan.totalSessions.toFloat()
    } else 0f

    val statusColor = when (plan.status.lowercase()) {
        "active"    -> WellnessSuccess
        "paused"    -> WellnessWarning
        "cancelled" -> WellnessDanger
        else        -> MaterialTheme.colorScheme.onSurfaceVariant
    }

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier            = Modifier.padding(Dimens.SpacingLg),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        ) {
            plan.patientName?.let { name ->
                Text(
                    text      = name.uppercase(),
                    style     = MaterialTheme.typography.labelSmall,
                    color     = MaterialTheme.colorScheme.onSurfaceVariant,
                    letterSpacing = 1.sp,
                )
            }

            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text       = plan.name,
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    modifier   = Modifier.weight(1f),
                )
                StatusBadge(status = plan.status.uppercase())
            }

            plan.serviceName?.let { svcName ->
                Text(
                    text  = svcName,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            LinearProgressIndicator(
                progress         = { progress },
                modifier         = Modifier.fillMaxWidth(),
                color            = statusColor,
                trackColor       = statusColor.copy(alpha = 0.2f),
            )
            Text(
                text  = "${plan.completedSessions}/${plan.totalSessions} sessions",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            plan.totalPrice?.let { price ->
                Text(
                    text  = "₹${String.format("%,.0f", price)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = WellnessPrimary,
                )
            }

            plan.nextDueAt?.let { due ->
                Text(
                    text  = "Next: $due",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (plan.status == "active" || plan.status == "paused") {
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    IconButton(onClick = onTogglePause, modifier = Modifier.size(36.dp)) {
                        Icon(
                            imageVector        = if (plan.status == "paused") Icons.Filled.PlayArrow else Icons.Filled.Pause,
                            contentDescription = if (plan.status == "paused") "Resume" else "Pause",
                            tint               = WellnessPrimary,
                            modifier           = Modifier.size(20.dp),
                        )
                    }
                    Spacer(Modifier.width(Dimens.SpacingXs))
                    IconButton(onClick = onCancel, modifier = Modifier.size(36.dp)) {
                        Icon(
                            imageVector        = Icons.Filled.Cancel,
                            contentDescription = "Cancel",
                            tint               = WellnessDanger,
                            modifier           = Modifier.size(20.dp),
                        )
                    }
                }
            }
        }
    }
}

// ─── Add / Edit form sheet ────────────────────────────────────────────────────

@Composable
private fun ServiceFormSheet(
    formState: ServiceFormState,
    isEditing: Boolean,
    onFieldChanged: (String, String) -> Unit,
    onSubmit: () -> Unit,
    onDismiss: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(Dimens.SpacingLg)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
    ) {
        Text(
            text       = if (isEditing) "Edit Service" else "Add Service",
            style      = MaterialTheme.typography.titleLarge,
            color      = WellnessPrimary,
            fontWeight = FontWeight.Bold,
        )

        // Name
        WellnessTextField(
            value         = formState.name,
            onValueChange = { onFieldChanged("name", it) },
            label         = "Service Name *",
            isError       = formState.nameError != null,
            errorMessage  = formState.nameError,
            modifier      = Modifier.fillMaxWidth(),
        )

        // Category dropdown
        FormDropdown(
            label       = "Category",
            selected    = formState.category,
            placeholder = "Select category",
            options     = listOf(
                "aesthetics"  to "Aesthetics",
                "dermatology" to "Dermatology",
                "wellness"    to "Wellness",
                "other"       to "Other",
            ),
            onSelect    = { onFieldChanged("category", it) },
        )

        // Ticket tier dropdown
        FormDropdown(
            label       = "Ticket Tier",
            selected    = formState.ticketTier,
            placeholder = "Select tier",
            options     = listOf(
                "high"   to "High",
                "medium" to "Medium",
                "low"    to "Low",
            ),
            onSelect    = { onFieldChanged("ticketTier", it) },
        )

        // Base price
        WellnessTextField(
            value         = formState.basePrice,
            onValueChange = { onFieldChanged("basePrice", it) },
            label         = "Base Price (₹) *",
            keyboardType  = KeyboardType.Decimal,
            isError       = formState.priceError != null,
            errorMessage  = formState.priceError,
            modifier      = Modifier.fillMaxWidth(),
        )

        // Duration
        WellnessTextField(
            value         = formState.durationMin,
            onValueChange = { onFieldChanged("durationMin", it) },
            label         = "Duration (minutes)",
            keyboardType  = KeyboardType.Number,
            modifier      = Modifier.fillMaxWidth(),
        )

        // Target radius (optional, for AT_HOME services)
        WellnessTextField(
            value         = formState.targetRadiusKm,
            onValueChange = { onFieldChanged("targetRadiusKm", it) },
            label         = "Home Delivery Radius (km, optional)",
            keyboardType  = KeyboardType.Decimal,
            modifier      = Modifier.fillMaxWidth(),
        )

        // Description
        WellnessTextField(
            value         = formState.description,
            onValueChange = { onFieldChanged("description", it) },
            label         = "Description (optional)",
            singleLine    = false,
            maxLines      = 4,
            modifier      = Modifier.fillMaxWidth(),
        )

        // Buttons
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
                text     = if (isEditing) "Update" else "Add Service",
                onClick  = onSubmit,
                modifier = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(Dimens.SpacingXl))
    }
}

// ─── Reusable dropdown for the form ──────────────────────────────────────────

@Composable
private fun FormDropdown(
    label: String,
    selected: String,
    placeholder: String,
    options: List<Pair<String, String>>,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val displayLabel = options.find { it.first == selected }?.second ?: placeholder

    Box(modifier = Modifier.fillMaxWidth()) {
        WellnessTextField(
            value         = if (selected.isBlank()) placeholder else displayLabel,
            onValueChange = {},
            label         = label,
            readOnly      = true,
            modifier      = Modifier.fillMaxWidth(),
            trailingIcon  = {
                IconButton(onClick = { expanded = true }) {
                    Icon(
                        imageVector        = Icons.Filled.Edit,
                        contentDescription = "expand",
                        modifier           = Modifier.size(16.dp),
                    )
                }
            },
        )
        // Invisible click-catcher over the entire text field area.
        Box(
            modifier = Modifier
                .matchParentSize()
                .clickable { expanded = true },
        )
        DropdownMenu(
            expanded         = expanded,
            onDismissRequest = { expanded = false },
        ) {
            options.forEach { (key, optionLabel) ->
                DropdownMenuItem(
                    text    = { Text(optionLabel) },
                    onClick = {
                        onSelect(key)
                        expanded = false
                    },
                )
            }
        }
    }
}

// ─── Previews ─────────────────────────────────────────────────────────────────

@Preview(name = "TreatmentPlanCard – active", showBackground = true)
@Composable
private fun TreatmentPlanCardActivePreview() {
    WellnessTheme {
        TreatmentPlanCard(
            plan = TreatmentPlan(
                id                = "1",
                name              = "Laser Hair Removal",
                status            = "active",
                totalSessions     = 6,
                completedSessions = 3,
                totalPrice        = 18000.0,
                nextDueAt         = "2026-05-20",
                startedAt         = "2026-04-01",
                patientName       = "Ramesh Kumar",
                serviceName       = "Laser Hair Removal",
            ),
            onTogglePause = {},
            onCancel      = {},
            modifier      = Modifier.padding(Dimens.SpacingLg),
        )
    }
}

@Preview(name = "TreatmentPlanCard – paused", showBackground = true)
@Composable
private fun TreatmentPlanCardPausedPreview() {
    WellnessTheme {
        TreatmentPlanCard(
            plan = TreatmentPlan(
                id                = "2",
                name              = "Anti-Ageing Facial",
                status            = "paused",
                totalSessions     = 3,
                completedSessions = 1,
                totalPrice        = 9000.0,
                nextDueAt         = null,
                startedAt         = "2026-03-15",
                patientName       = "Priya Singh",
                serviceName       = "Anti-Ageing Facial",
            ),
            onTogglePause = {},
            onCancel      = {},
            modifier      = Modifier.padding(Dimens.SpacingLg),
        )
    }
}
