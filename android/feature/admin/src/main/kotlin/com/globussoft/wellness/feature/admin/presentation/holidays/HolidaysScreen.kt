package com.globussoft.wellness.feature.admin.presentation.holidays

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Event
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.ConfirmDialog
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.feature.admin.domain.repository.HolidayItem
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HolidaysScreen(
    viewModel: HolidaysViewModel = hiltViewModel(),
    onNavigateBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is HolidaysEffect.ShowSnackbar -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text("Holidays", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) },
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
                onClick        = { viewModel.onEvent(HolidaysEvent.OpenNewSheet) },
                icon           = { Icon(Icons.Default.Add, contentDescription = null) },
                text           = { Text("Add Holiday") },
                containerColor = WellnessPrimary,
                contentColor   = Color.White,
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.holidays.isNotEmpty(),
            onRefresh    = { viewModel.onEvent(HolidaysEvent.Refresh) },
            modifier     = Modifier.fillMaxSize().padding(contentPadding),
        ) {
            when {
                state.isLoading && state.holidays.isEmpty() ->
                    ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                state.error != null && state.holidays.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = { viewModel.onEvent(HolidaysEvent.Refresh) }, modifier = Modifier.fillMaxSize())
                state.holidays.isEmpty() ->
                    EmptyState(message = "No holidays configured for this year.", icon = Icons.Default.Event, actionLabel = "Add Holiday", onAction = { viewModel.onEvent(HolidaysEvent.OpenNewSheet) }, modifier = Modifier.fillMaxSize())
                else -> LazyColumn(
                    contentPadding      = PaddingValues(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    modifier            = Modifier.fillMaxSize(),
                ) {
                    items(state.holidays, key = { it.id }) { item ->
                        HolidayCard(
                            item     = item,
                            onDelete = { viewModel.onEvent(HolidaysEvent.RequestDelete(item.id)) },
                        )
                    }
                }
            }
        }

        if (state.showSheet) {
            HolidayFormSheet(
                form      = state.form,
                locations = state.locations,
                isSaving  = state.isSaving,
                saveError = state.saveError,
                onField   = { field, value -> viewModel.onEvent(HolidaysEvent.FieldChanged(field, value)) },
                onSave    = { viewModel.onEvent(HolidaysEvent.Save) },
                onDismiss = { viewModel.onEvent(HolidaysEvent.DismissSheet) },
            )
        }

        if (state.showDeleteConfirm) {
            ConfirmDialog(
                title         = "Remove Holiday",
                message       = "Remove this holiday from the calendar?",
                confirmLabel  = "Remove",
                isDestructive = true,
                onConfirm     = { viewModel.onEvent(HolidaysEvent.ConfirmDelete) },
                onDismiss     = { viewModel.onEvent(HolidaysEvent.DismissDelete) },
            )
        }
    }
}

@Composable
private fun HolidayCard(
    item: HolidayItem,
    onDelete: () -> Unit,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier              = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = item.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(Dimens.SpacingXs))
                val meta = buildList {
                    add(item.date)
                    if (!item.locationName.isNullOrBlank()) add(item.locationName)
                }.joinToString(" · ")
                Text(text = meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = onDelete, modifier = Modifier.size(36.dp)) {
                Icon(Icons.Default.Delete, contentDescription = "Delete", tint = WellnessDanger, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HolidayFormSheet(
    form: HolidayForm,
    locations: List<Location>,
    isSaving: Boolean,
    saveError: String?,
    onField: (String, String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState       = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            modifier            = Modifier.fillMaxWidth().padding(Dimens.SpacingLg).padding(bottom = Dimens.SpacingXxl),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            Text("New Holiday", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            HorizontalDivider()
            OutlinedTextField(
                value         = form.date,
                onValueChange = { onField("date", it) },
                label         = { Text("Date (YYYY-MM-DD) *") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
                placeholder   = { Text("2025-08-15") },
            )
            OutlinedTextField(
                value         = form.name,
                onValueChange = { onField("name", it) },
                label         = { Text("Holiday Name *") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
            )
            if (locations.isNotEmpty()) {
                LocationSelector(
                    locations  = locations,
                    selectedId = form.locationId,
                    onSelected = { onField("locationId", it) },
                    modifier   = Modifier.fillMaxWidth(),
                )
            }
            if (saveError != null) {
                Text(text = saveError, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            WellnessButton(
                text      = "Add Holiday",
                onClick   = onSave,
                isLoading = isSaving,
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun LocationSelector(
    locations: List<Location>,
    selectedId: String,
    onSelected: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedName = locations.find { it.id == selectedId }?.name ?: "All Locations"

    Box(modifier = modifier) {
        OutlinedTextField(
            value         = selectedName,
            onValueChange = {},
            readOnly      = true,
            label         = { Text("Location (optional)") },
            modifier      = Modifier.fillMaxWidth(),
            singleLine    = true,
            trailingIcon  = { TextButton(onClick = { expanded = true }) { Text("Change") } },
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(text = { Text("All Locations") }, onClick = { onSelected(""); expanded = false })
            locations.forEach { loc ->
                DropdownMenuItem(text = { Text(loc.name) }, onClick = { onSelected(loc.id); expanded = false })
            }
        }
    }
}
