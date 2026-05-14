package com.globussoft.wellness.feature.admin.presentation.resources

import androidx.compose.foundation.background
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Settings
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
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import androidx.navigation.compose.rememberNavController
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import kotlinx.coroutines.launch

private val TypeBadgeRoom      = Color(0xFF3B82F6) // blue
private val TypeBadgeEquipment = Color(0xFF8B5CF6) // purple

private val RESOURCE_TYPES = listOf("room", "equipment")

/**
 * Resources admin screen.
 *
 * Lists all treatment rooms and equipment. Provides an "Add Resource" FAB
 * that opens a [ModalBottomSheet] form. Add and delete operations currently
 * show a "Not yet available" snackbar until the server-side endpoint is wired.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ResourcesScreen(
    viewModel: ResourcesViewModel = hiltViewModel(),
    navController: NavController,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is ResourcesEffect.ShowSnackbar -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        "Resources",
                        style      = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = { navController.popBackStack() }) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick        = { viewModel.onEvent(ResourcesEvent.ToggleAddForm) },
                icon           = { Icon(Icons.Default.Add, contentDescription = null) },
                text           = { Text("New Resource") },
                containerColor = WellnessPrimary,
                contentColor   = Color.White,
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.resources.isNotEmpty(),
            onRefresh    = { viewModel.onEvent(ResourcesEvent.Refresh) },
            modifier     = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            when {
                state.isLoading && state.resources.isEmpty() -> {
                    ShimmerList(itemCount = 4, modifier = Modifier.fillMaxSize())
                }
                state.error != null && state.resources.isEmpty() -> {
                    ErrorState(
                        message  = state.error!!,
                        onRetry  = { viewModel.onEvent(ResourcesEvent.Refresh) },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.resources.isEmpty() -> {
                    EmptyState(
                        message     = "No resources yet. Tap \"New Resource\" to add a room or equipment.",
                        icon        = Icons.Default.Settings,
                        actionLabel = "New Resource",
                        onAction    = { viewModel.onEvent(ResourcesEvent.ToggleAddForm) },
                        modifier    = Modifier.fillMaxSize(),
                    )
                }
                else -> {
                    LazyColumn(
                        contentPadding      = PaddingValues(Dimens.SpacingLg),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                        modifier            = Modifier.fillMaxSize(),
                    ) {
                        items(state.resources, key = { it.id }) { resource ->
                            ResourceCard(
                                resource = resource,
                                onDelete = { viewModel.onEvent(ResourcesEvent.DeleteResource(resource.id)) },
                            )
                        }
                    }
                }
            }
        }

        if (state.showAddForm) {
            ResourceFormSheet(
                form      = state.addForm,
                isSaving  = state.isCreating,
                onField   = { field, value -> viewModel.onEvent(ResourcesEvent.FormFieldChanged(field, value)) },
                onSave    = { viewModel.onEvent(ResourcesEvent.SubmitForm) },
                onDismiss = { viewModel.onEvent(ResourcesEvent.ToggleAddForm) },
            )
        }
    }
}

// ─── Resource card ────────────────────────────────────────────────────────────

@Composable
private fun ResourceCard(
    resource: Resource,
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
                        text       = resource.name,
                        style      = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(modifier = Modifier.width(Dimens.SpacingSm))
                    ResourceTypeBadge(type = resource.type)
                }
                Spacer(modifier = Modifier.height(Dimens.SpacingXs))
                Row(
                    verticalAlignment  = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                ) {
                    val capacityText = resource.capacity?.let { "Capacity: $it" }
                    if (capacityText != null) {
                        Text(
                            text  = capacityText,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text(
                        text  = if (resource.isActive) "Active" else "Inactive",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (resource.isActive) WellnessPrimary
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                        fontWeight = FontWeight.Medium,
                    )
                }
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

@Composable
private fun ResourceTypeBadge(type: String) {
    val color = when (type.lowercase()) {
        "room"      -> TypeBadgeRoom
        "equipment" -> TypeBadgeEquipment
        else        -> TypeBadgeRoom
    }
    val label = type.replaceFirstChar { it.uppercase() }
    Box(
        modifier = Modifier
            .background(color = color, shape = RoundedCornerShape(100))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = label,
            style = MaterialTheme.typography.labelSmall,
            color = Color.White,
        )
    }
}

// ─── Add bottom sheet ─────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ResourceFormSheet(
    form: ResourcesAddForm,
    isSaving: Boolean,
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
                text       = "New Resource",
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

            ResourceTypeSelector(
                selected   = form.type,
                onSelected = { onField("type", it) },
                modifier   = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value         = form.capacity,
                onValueChange = { onField("capacity", it) },
                label         = { Text("Capacity (optional)") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
            )

            WellnessButton(
                text      = "Create",
                onClick   = onSave,
                isLoading = isSaving,
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun ResourceTypeSelector(
    selected: String,
    onSelected: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }

    Box(modifier = modifier) {
        OutlinedTextField(
            value         = selected.replaceFirstChar { it.uppercase() },
            onValueChange = {},
            readOnly      = true,
            label         = { Text("Type") },
            modifier      = Modifier.fillMaxWidth(),
            singleLine    = true,
            trailingIcon  = {
                TextButton(onClick = { expanded = true }) { Text("Change") }
            },
        )
        DropdownMenu(
            expanded         = expanded,
            onDismissRequest = { expanded = false },
        ) {
            RESOURCE_TYPES.forEach { type ->
                DropdownMenuItem(
                    text    = { Text(type.replaceFirstChar { it.uppercase() }) },
                    onClick = {
                        onSelected(type)
                        expanded = false
                    },
                )
            }
        }
    }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "ResourcesScreen – loaded", showBackground = true)
@Composable
private fun ResourcesScreenPreview() {
    WellnessTheme {
        LazyColumn(
            contentPadding      = PaddingValues(Dimens.SpacingLg),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            items(
                listOf(
                    Resource("1", "Room A", "room", 3, true),
                    Resource("2", "Laser Machine", "equipment", null, true),
                    Resource("3", "Room B", "room", 2, false),
                )
            ) { resource ->
                ResourceCard(resource = resource, onDelete = {})
            }
        }
    }
}
