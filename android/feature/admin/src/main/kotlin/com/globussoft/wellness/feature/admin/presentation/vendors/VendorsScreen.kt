package com.globussoft.wellness.feature.admin.presentation.vendors

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
import androidx.compose.material.icons.filled.Business
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
import com.globussoft.wellness.feature.admin.domain.repository.VendorItem
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VendorsScreen(
    viewModel: VendorsViewModel = hiltViewModel(),
    onNavigateBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is VendorsEffect.ShowSnackbar -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text("Vendors", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) },
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
                onClick        = { viewModel.onEvent(VendorsEvent.OpenNewSheet) },
                icon           = { Icon(Icons.Default.Add, contentDescription = null) },
                text           = { Text("New Vendor") },
                containerColor = WellnessPrimary,
                contentColor   = Color.White,
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.vendors.isNotEmpty(),
            onRefresh    = { viewModel.onEvent(VendorsEvent.Refresh) },
            modifier     = Modifier.fillMaxSize().padding(contentPadding),
        ) {
            when {
                state.isLoading && state.vendors.isEmpty() ->
                    ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                state.error != null && state.vendors.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = { viewModel.onEvent(VendorsEvent.Refresh) }, modifier = Modifier.fillMaxSize())
                state.vendors.isEmpty() ->
                    EmptyState(message = "No vendors added yet.", icon = Icons.Default.Business, actionLabel = "Add Vendor", onAction = { viewModel.onEvent(VendorsEvent.OpenNewSheet) }, modifier = Modifier.fillMaxSize())
                else -> LazyColumn(
                    contentPadding      = PaddingValues(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    modifier            = Modifier.fillMaxSize(),
                ) {
                    items(state.vendors, key = { it.id }) { item ->
                        VendorCard(
                            item     = item,
                            onEdit   = { viewModel.onEvent(VendorsEvent.OpenEditSheet(item)) },
                            onDelete = { viewModel.onEvent(VendorsEvent.RequestDelete(item.id)) },
                        )
                    }
                }
            }
        }

        if (state.showSheet) {
            VendorFormSheet(
                isEditing = state.editingItem != null,
                form      = state.form,
                isSaving  = state.isSaving,
                saveError = state.saveError,
                onField   = { field, value -> viewModel.onEvent(VendorsEvent.FieldChanged(field, value)) },
                onSave    = { viewModel.onEvent(VendorsEvent.Save) },
                onDismiss = { viewModel.onEvent(VendorsEvent.DismissSheet) },
            )
        }

        if (state.showDeleteConfirm) {
            ConfirmDialog(
                title         = "Delete Vendor",
                message       = "Remove this vendor from your records?",
                confirmLabel  = "Delete",
                isDestructive = true,
                onConfirm     = { viewModel.onEvent(VendorsEvent.ConfirmDelete) },
                onDismiss     = { viewModel.onEvent(VendorsEvent.DismissDelete) },
            )
        }
    }
}

@Composable
private fun VendorCard(
    item: VendorItem,
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
                val meta = listOfNotNull(item.contactPerson, item.phone, item.email)
                    .filter { it.isNotBlank() }.joinToString(" · ")
                if (meta.isNotBlank()) {
                    Text(text = meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!item.gstin.isNullOrBlank()) {
                    Text(text = "GSTIN: ${item.gstin}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
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
private fun VendorFormSheet(
    isEditing: Boolean,
    form: VendorForm,
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
            Text(
                text       = if (isEditing) "Edit Vendor" else "New Vendor",
                style      = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            HorizontalDivider()
            OutlinedTextField(
                value         = form.name,
                onValueChange = { onField("name", it) },
                label         = { Text("Vendor Name *") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
            )
            OutlinedTextField(
                value         = form.contactPerson,
                onValueChange = { onField("contactPerson", it) },
                label         = { Text("Contact Person") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
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
            OutlinedTextField(
                value         = form.gstin,
                onValueChange = { onField("gstin", it) },
                label         = { Text("GSTIN") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
            )
            if (saveError != null) {
                Text(text = saveError, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            WellnessButton(
                text      = if (isEditing) "Update" else "Add Vendor",
                onClick   = onSave,
                isLoading = isSaving,
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}
