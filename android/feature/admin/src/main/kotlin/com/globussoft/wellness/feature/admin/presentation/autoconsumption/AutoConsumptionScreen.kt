package com.globussoft.wellness.feature.admin.presentation.autoconsumption

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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Science
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
import androidx.compose.material3.Switch
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
import com.globussoft.wellness.feature.admin.domain.repository.AutoConsumptionRuleItem
import com.globussoft.wellness.feature.admin.domain.repository.ProductItem
import com.globussoft.wellness.feature.admin.domain.repository.ServiceItem
// ProductItem and ServiceItem used by ViewModel state passed into this composable
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AutoConsumptionScreen(
    viewModel: AutoConsumptionViewModel = hiltViewModel(),
    onNavigateBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is AutoConsumptionEffect.ShowSnackbar -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text("Auto-consumption Rules", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) },
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
                onClick        = { viewModel.onEvent(AutoConsumptionEvent.OpenNewSheet) },
                icon           = { Icon(Icons.Default.Add, contentDescription = null) },
                text           = { Text("New Rule") },
                containerColor = WellnessPrimary,
                contentColor   = Color.White,
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.rules.isNotEmpty(),
            onRefresh    = { viewModel.onEvent(AutoConsumptionEvent.Refresh) },
            modifier     = Modifier.fillMaxSize().padding(contentPadding),
        ) {
            when {
                state.isLoading && state.rules.isEmpty() ->
                    ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                state.error != null && state.rules.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = { viewModel.onEvent(AutoConsumptionEvent.Refresh) }, modifier = Modifier.fillMaxSize())
                state.rules.isEmpty() ->
                    EmptyState(message = "No auto-consumption rules set up.", icon = Icons.Default.Science, actionLabel = "Add Rule", onAction = { viewModel.onEvent(AutoConsumptionEvent.OpenNewSheet) }, modifier = Modifier.fillMaxSize())
                else -> LazyColumn(
                    contentPadding      = PaddingValues(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    modifier            = Modifier.fillMaxSize(),
                ) {
                    items(state.rules, key = { it.id }) { item ->
                        AutoConsumptionCard(
                            item     = item,
                            onEdit   = { viewModel.onEvent(AutoConsumptionEvent.OpenEditSheet(item)) },
                            onDelete = { viewModel.onEvent(AutoConsumptionEvent.RequestDelete(item.id)) },
                        )
                    }
                }
            }
        }

        if (state.showSheet) {
            AutoConsumptionFormSheet(
                isEditing = state.editingItem != null,
                form      = state.form,
                services  = state.services,
                products  = state.products,
                isSaving  = state.isSaving,
                saveError = state.saveError,
                onSelectService = { viewModel.onEvent(AutoConsumptionEvent.SelectService(it)) },
                onSelectProduct = { viewModel.onEvent(AutoConsumptionEvent.SelectProduct(it)) },
                onField   = { field, value -> viewModel.onEvent(AutoConsumptionEvent.FieldChanged(field, value)) },
                onToggle  = { viewModel.onEvent(AutoConsumptionEvent.ToggleActive(it)) },
                onSave    = { viewModel.onEvent(AutoConsumptionEvent.Save) },
                onDismiss = { viewModel.onEvent(AutoConsumptionEvent.DismissSheet) },
            )
        }

        if (state.showDeleteConfirm) {
            ConfirmDialog(
                title         = "Delete Rule",
                message       = "Remove this auto-consumption rule?",
                confirmLabel  = "Delete",
                isDestructive = true,
                onConfirm     = { viewModel.onEvent(AutoConsumptionEvent.ConfirmDelete) },
                onDismiss     = { viewModel.onEvent(AutoConsumptionEvent.DismissDelete) },
            )
        }
    }
}

@Composable
private fun AutoConsumptionCard(
    item: AutoConsumptionRuleItem,
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
                Text(
                    text       = "${item.serviceName} → ${item.productName}",
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(modifier = Modifier.height(Dimens.SpacingXs))
                val meta = buildList {
                    add("× ${item.quantityPerVisit} per visit")
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
private fun AutoConsumptionFormSheet(
    isEditing: Boolean,
    form: AutoConsumptionForm,
    services: List<ServiceItem>,
    products: List<ProductItem>,
    isSaving: Boolean,
    saveError: String?,
    onSelectService: (String) -> Unit,
    onSelectProduct: (String) -> Unit,
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
                text       = if (isEditing) "Edit Rule" else "New Rule",
                style      = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            HorizontalDivider()
            NamedItemPicker(
                label      = "Service *",
                entries    = services.map { it.id to it.name },
                selectedId = form.serviceId,
                onSelected = onSelectService,
                modifier   = Modifier.fillMaxWidth(),
            )
            NamedItemPicker(
                label      = "Product *",
                entries    = products.map { it.id to it.name },
                selectedId = form.productId,
                onSelected = onSelectProduct,
                modifier   = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value           = form.quantityPerVisit,
                onValueChange   = { onField("quantityPerVisit", it) },
                label           = { Text("Qty per Visit *") },
                modifier        = Modifier.fillMaxWidth(),
                singleLine      = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
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
                text      = if (isEditing) "Update" else "Add Rule",
                onClick   = onSave,
                isLoading = isSaving,
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun NamedItemPicker(
    label: String,
    entries: List<Pair<String, String>>,
    selectedId: String,
    onSelected: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedName = entries.find { it.first == selectedId }?.second ?: "Select…"

    Box(modifier = modifier) {
        OutlinedTextField(
            value         = selectedName,
            onValueChange = {},
            readOnly      = true,
            label         = { Text(label) },
            modifier      = Modifier.fillMaxWidth(),
            singleLine    = true,
            trailingIcon  = { TextButton(onClick = { expanded = true }) { Text("Change") } },
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            entries.forEach { (id, name) ->
                DropdownMenuItem(text = { Text(name) }, onClick = { onSelected(id); expanded = false })
            }
        }
    }
}
