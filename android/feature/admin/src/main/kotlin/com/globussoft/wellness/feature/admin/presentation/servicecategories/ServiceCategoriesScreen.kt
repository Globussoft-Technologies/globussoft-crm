package com.globussoft.wellness.feature.admin.presentation.servicecategories

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
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
import com.globussoft.wellness.feature.admin.domain.repository.ServiceCategoryItem
import kotlinx.coroutines.launch
import androidx.compose.foundation.text.KeyboardOptions

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServiceCategoriesScreen(
    viewModel: ServiceCategoriesViewModel = hiltViewModel(),
    onNavigateBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is ServiceCategoriesEffect.ShowSnackbar -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text("Service Categories", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) },
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
                onClick        = { viewModel.onEvent(ServiceCategoriesEvent.OpenNewSheet) },
                icon           = { Icon(Icons.Default.Add, contentDescription = null) },
                text           = { Text("New Category") },
                containerColor = WellnessPrimary,
                contentColor   = Color.White,
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.categories.isNotEmpty(),
            onRefresh    = { viewModel.onEvent(ServiceCategoriesEvent.Refresh) },
            modifier     = Modifier.fillMaxSize().padding(contentPadding),
        ) {
            when {
                state.isLoading && state.categories.isEmpty() ->
                    ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                state.error != null && state.categories.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = { viewModel.onEvent(ServiceCategoriesEvent.Refresh) }, modifier = Modifier.fillMaxSize())
                state.categories.isEmpty() ->
                    EmptyState(message = "No service categories yet.", icon = Icons.Default.Category, actionLabel = "Add Category", onAction = { viewModel.onEvent(ServiceCategoriesEvent.OpenNewSheet) }, modifier = Modifier.fillMaxSize())
                else -> LazyColumn(
                    contentPadding      = PaddingValues(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    modifier            = Modifier.fillMaxSize(),
                ) {
                    items(state.categories, key = { it.id }) { item ->
                        ServiceCategoryCard(
                            item     = item,
                            onEdit   = { viewModel.onEvent(ServiceCategoriesEvent.OpenEditSheet(item)) },
                            onDelete = { viewModel.onEvent(ServiceCategoriesEvent.RequestDelete(item.id)) },
                        )
                    }
                }
            }
        }

        if (state.showSheet) {
            ServiceCategoryFormSheet(
                isEditing = state.editingItem != null,
                form      = state.form,
                isSaving  = state.isSaving,
                saveError = state.saveError,
                onField   = { field, value -> viewModel.onEvent(ServiceCategoriesEvent.FieldChanged(field, value)) },
                onToggle  = { viewModel.onEvent(ServiceCategoriesEvent.ToggleActive(it)) },
                onSave    = { viewModel.onEvent(ServiceCategoriesEvent.Save) },
                onDismiss = { viewModel.onEvent(ServiceCategoriesEvent.DismissSheet) },
            )
        }

        if (state.showDeleteConfirm) {
            ConfirmDialog(
                title         = "Delete Category",
                message       = "Remove this service category? Services under it may be affected.",
                confirmLabel  = "Delete",
                isDestructive = true,
                onConfirm     = { viewModel.onEvent(ServiceCategoriesEvent.ConfirmDelete) },
                onDismiss     = { viewModel.onEvent(ServiceCategoriesEvent.DismissDelete) },
            )
        }
    }
}

@Composable
private fun ServiceCategoryCard(
    item: ServiceCategoryItem,
    onEdit: () -> Unit,
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
                    if (!item.parentName.isNullOrBlank()) add("Parent: ${item.parentName}")
                    if (item.serviceCount > 0) add("${item.serviceCount} services")
                    add(if (item.isActive) "Active" else "Inactive")
                }.joinToString(" · ")
                Text(text = meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row {
                IconButton(onClick = onEdit, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Default.Edit, contentDescription = "Edit", tint = WellnessPrimary, modifier = Modifier.size(18.dp))
                }
                IconButton(onClick = onDelete, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Default.Delete, contentDescription = "Delete", tint = WellnessDanger, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ServiceCategoryFormSheet(
    isEditing: Boolean,
    form: ServiceCategoryForm,
    isSaving: Boolean,
    saveError: String?,
    onField: (String, String) -> Unit,
    onToggle: (Boolean) -> Unit,
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
            Text(
                text       = if (isEditing) "Edit Category" else "New Category",
                style      = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            HorizontalDivider()
            OutlinedTextField(
                value         = form.name,
                onValueChange = { onField("name", it) },
                label         = { Text("Category Name *") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
            )
            OutlinedTextField(
                value         = form.displayOrder,
                onValueChange = { onField("displayOrder", it) },
                label         = { Text("Display Order") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text("Active", style = MaterialTheme.typography.bodyMedium)
                Switch(checked = form.isActive, onCheckedChange = onToggle)
            }
            if (saveError != null) {
                Text(text = saveError, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            WellnessButton(
                text      = if (isEditing) "Update" else "Add Category",
                onClick   = onSave,
                isLoading = isSaving,
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}
