package com.globussoft.wellness.feature.admin.presentation.locations

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.ConfirmDialog
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.core.domain.model.Location
import kotlinx.coroutines.launch

/**
 * Locations CRUD screen.
 *
 * Lists all clinic locations with name, city/state, phone, and active badge.
 * Provides a "New Location" FAB and per-card edit / delete actions.
 * Create / edit operations use a [ModalBottomSheet] form with inline validation.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LocationsScreen(
    viewModel: LocationsViewModel = hiltViewModel(),
    onNavigateBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = androidx.compose.runtime.remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is LocationsEffect.ShowSnackbar -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text("Locations", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick          = { viewModel.onEvent(LocationsEvent.OpenNewSheet) },
                icon             = { Icon(Icons.Default.Add, contentDescription = null) },
                text             = { Text("New Location") },
                containerColor   = WellnessPrimary,
                contentColor     = androidx.compose.ui.graphics.Color.White,
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.locations.isNotEmpty(),
            onRefresh    = { viewModel.onEvent(LocationsEvent.Refresh) },
            modifier     = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            when {
                state.isLoading && state.locations.isEmpty() -> {
                    ShimmerList(itemCount = 4, modifier = Modifier.fillMaxSize())
                }
                state.error != null && state.locations.isEmpty() -> {
                    ErrorState(
                        message  = state.error!!,
                        onRetry  = { viewModel.onEvent(LocationsEvent.Refresh) },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.locations.isEmpty() -> {
                    EmptyState(
                        message     = "No locations yet. Tap \"New Location\" to add your first branch.",
                        icon        = Icons.Default.LocationOn,
                        actionLabel = "New Location",
                        onAction    = { viewModel.onEvent(LocationsEvent.OpenNewSheet) },
                        modifier    = Modifier.fillMaxSize(),
                    )
                }
                else -> {
                    LazyColumn(
                        contentPadding      = PaddingValues(Dimens.SpacingLg),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                        modifier            = Modifier.fillMaxSize(),
                    ) {
                        items(state.locations, key = { it.id }) { loc ->
                            LocationCard(
                                location = loc,
                                onEdit   = { viewModel.onEvent(LocationsEvent.OpenEditSheet(loc)) },
                                onDelete = { viewModel.onEvent(LocationsEvent.RequestDelete(loc.id)) },
                            )
                        }
                    }
                }
            }
        }

        // Bottom sheet for create / edit.
        if (state.showSheet) {
            LocationFormSheet(
                isEditing  = state.editingLocation != null,
                form       = state.form,
                isSaving   = state.isSaving,
                saveError  = state.saveError,
                onField    = { field, value -> viewModel.onEvent(LocationsEvent.FieldChanged(field, value)) },
                onSave     = { viewModel.onEvent(LocationsEvent.Save) },
                onDismiss  = { viewModel.onEvent(LocationsEvent.DismissSheet) },
            )
        }

        // Delete confirmation.
        if (state.showDeleteConfirm) {
            ConfirmDialog(
                title         = "Delete Location",
                message       = "This location will be permanently removed. Historical visit data will be retained.",
                confirmLabel  = "Delete",
                isDestructive = true,
                onConfirm     = { viewModel.onEvent(LocationsEvent.ConfirmDelete) },
                onDismiss     = { viewModel.onEvent(LocationsEvent.DismissDelete) },
            )
        }
    }
}

// ─── Location card ────────────────────────────────────────────────────────────

@Composable
private fun LocationCard(
    location: Location,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.Top,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text       = location.name,
                        style      = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(modifier = Modifier.width(Dimens.SpacingSm))
                    StatusBadge(
                        status = if (location.isActive) "COMPLETED" else "CANCELLED",
                    )
                }
                Spacer(modifier = Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = "${location.city}, ${location.state}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val locationPhone = location.phone
                if (!locationPhone.isNullOrBlank()) {
                    Text(
                        text  = locationPhone,
                        style = MaterialTheme.typography.bodySmall,
                        color = WellnessPrimary,
                    )
                }
            }
            Row {
                IconButton(onClick = onEdit, modifier = Modifier.size(36.dp)) {
                    Icon(
                        imageVector        = Icons.Default.Edit,
                        contentDescription = "Edit",
                        tint               = WellnessPrimary,
                        modifier           = Modifier.size(18.dp),
                    )
                }
                IconButton(onClick = onDelete, modifier = Modifier.size(36.dp)) {
                    Icon(
                        imageVector        = Icons.Default.Delete,
                        contentDescription = "Delete",
                        tint               = WellnessDanger,
                        modifier           = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}

// ─── Create/Edit bottom sheet ─────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LocationFormSheet(
    isEditing: Boolean,
    form: LocationFormState,
    isSaving: Boolean,
    saveError: String?,
    onField: (String, String) -> Unit,
    onSave: () -> Unit,
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
            Text(
                text       = if (isEditing) "Edit Location" else "New Location",
                style      = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            HorizontalDivider()

            OutlinedTextField(
                value         = form.name,
                onValueChange = { onField("name", it) },
                label         = { Text("Name *") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
            )
            OutlinedTextField(
                value         = form.addressLine,
                onValueChange = { onField("addressLine", it) },
                label         = { Text("Address") },
                modifier      = Modifier.fillMaxWidth(),
                minLines      = 2,
                maxLines      = 3,
            )
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                OutlinedTextField(
                    value         = form.city,
                    onValueChange = { onField("city", it) },
                    label         = { Text("City") },
                    modifier      = Modifier.weight(1f),
                    singleLine    = true,
                )
                OutlinedTextField(
                    value         = form.state,
                    onValueChange = { onField("state", it) },
                    label         = { Text("State") },
                    modifier      = Modifier.weight(1f),
                    singleLine    = true,
                )
            }
            OutlinedTextField(
                value         = form.pincode,
                onValueChange = { onField("pincode", it) },
                label         = { Text("Pincode") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
                isError       = form.pincodeError != null,
                supportingText = form.pincodeError?.let { { Text(it) } },
            )
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                OutlinedTextField(
                    value         = form.phone,
                    onValueChange = { onField("phone", it) },
                    label         = { Text("Phone") },
                    modifier      = Modifier.weight(1f),
                    singleLine    = true,
                )
                OutlinedTextField(
                    value         = form.email,
                    onValueChange = { onField("email", it) },
                    label         = { Text("Email") },
                    modifier      = Modifier.weight(1f),
                    singleLine    = true,
                )
            }

            if (saveError != null) {
                Text(
                    text  = saveError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            WellnessButton(
                text      = if (isEditing) "Update" else "Create",
                onClick   = onSave,
                isLoading = isSaving,
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "LocationsScreen – loaded", showBackground = true)
@Composable
private fun LocationsScreenPreview() {
    WellnessTheme {
        LazyColumn(
            contentPadding      = PaddingValues(Dimens.SpacingLg),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            items(
                listOf(
                    Location("1", "Main Clinic", "12 MG Road", "Bengaluru", "Karnataka", "560001", "+91 80 1234 5678", "main@ewellness.in", true),
                    Location("2", "HSR Branch", "5th Sector", "Bengaluru", "Karnataka", "560102", null, null, false),
                )
            ) { loc ->
                LocationCard(location = loc, onEdit = {}, onDelete = {})
            }
        }
    }
}
