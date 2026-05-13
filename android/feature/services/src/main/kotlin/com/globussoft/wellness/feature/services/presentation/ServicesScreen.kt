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
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.ConfirmDialog
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessTabStrip
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.domain.model.Service
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
                        1    -> PackagesTab()
                        else -> ActiveTreatmentsTab()
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
            Row(
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                if (!service.category.isNullOrBlank()) {
                    StatusBadge(status = service.category)
                }
                if (!service.ticketTier.isNullOrBlank()) {
                    StatusBadge(status = service.ticketTier)
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
            if (!service.description.isNullOrBlank()) {
                Spacer(Modifier.height(Dimens.SpacingXs))
                Text(
                    text     = service.description,
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

// ─── Packages tab (placeholder) ───────────────────────────────────────────────

@Composable
private fun PackagesTab() {
    Box(
        modifier          = Modifier
            .fillMaxSize()
            .padding(Dimens.SpacingXl),
        contentAlignment  = Alignment.Center,
    ) {
        WellnessCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier              = Modifier.padding(Dimens.SpacingXl),
                horizontalAlignment   = Alignment.CenterHorizontally,
                verticalArrangement   = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                Icon(
                    imageVector        = Icons.Filled.Extension,
                    contentDescription = null,
                    tint               = WellnessPrimary.copy(alpha = 0.5f),
                    modifier           = Modifier.size(48.dp),
                )
                Text(
                    text       = "Service Packages",
                    style      = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color      = WellnessPrimary,
                )
                Text(
                    text  = "Bundle multiple services into packages. Contact admin to configure.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

// ─── Active treatments tab (placeholder) ─────────────────────────────────────

@Composable
private fun ActiveTreatmentsTab() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
    ) {
        Text(
            text       = "Active Treatment Plans",
            style      = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            color      = WellnessPrimary,
        )
        Text(
            text  = "Showing patients with ongoing treatment plans across all services.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Placeholder cards — replaced with real data when Treatment Plan endpoints
        // are wired into the Services repository.
        val placeholderPlans = listOf(
            Triple("Ramesh Kumar", "Laser Hair Removal – 6 sessions", "Session 3 / 6"),
            Triple("Priya Singh", "Anti-Ageing Facial – 3 months", "Month 1 / 3"),
            Triple("Anjali Mehta", "PRP Scalp Therapy – 4 sessions", "Session 2 / 4"),
        )

        placeholderPlans.forEach { (patient, plan, progress) ->
            TreatmentPlanPlaceholderCard(
                patientName = patient,
                planName    = plan,
                progress    = progress,
            )
        }
    }
}

@Composable
private fun TreatmentPlanPlaceholderCard(
    patientName: String,
    planName: String,
    progress: String,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text       = patientName,
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    text  = planName,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            StatusBadge(status = "IN_TREATMENT")
        }
        // Progress text
        Text(
            text     = progress,
            style    = MaterialTheme.typography.labelSmall,
            color    = WellnessPrimary,
            modifier = Modifier.padding(start = Dimens.SpacingLg, bottom = Dimens.SpacingMd),
        )
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
