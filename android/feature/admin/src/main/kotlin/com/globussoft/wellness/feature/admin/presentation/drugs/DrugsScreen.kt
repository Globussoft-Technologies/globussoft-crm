package com.globussoft.wellness.feature.admin.presentation.drugs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MedicalServices
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
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
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.feature.admin.domain.repository.DrugItem
import kotlinx.coroutines.launch

/**
 * Drug Catalogue CRUD screen.
 *
 * Lists all drugs in the tenant's formulary.  Provides an "Add Drug" FAB and
 * per-card edit / delete actions.  Create / edit operations use a
 * [ModalBottomSheet] form with a dosage form dropdown.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DrugsScreen(
    viewModel: DrugsViewModel = hiltViewModel(),
    onNavigateBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is DrugsEffect.ShowSnackbar -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text("Drug Catalogue", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) },
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
                onClick        = { viewModel.onEvent(DrugsEvent.OpenNewSheet) },
                icon           = { Icon(Icons.Default.Add, contentDescription = null) },
                text           = { Text("New Drug") },
                containerColor = WellnessPrimary,
                contentColor   = Color.White,
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.drugs.isNotEmpty(),
            onRefresh    = { viewModel.onEvent(DrugsEvent.Refresh) },
            modifier     = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            when {
                state.isLoading && state.drugs.isEmpty() -> {
                    ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                }
                state.error != null && state.drugs.isEmpty() -> {
                    ErrorState(
                        message  = state.error!!,
                        onRetry  = { viewModel.onEvent(DrugsEvent.Refresh) },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.drugs.isEmpty() -> {
                    EmptyState(
                        message     = "No drugs in the catalogue. Add one to start prescribing.",
                        icon        = Icons.Default.MedicalServices,
                        actionLabel = "Add Drug",
                        onAction    = { viewModel.onEvent(DrugsEvent.OpenNewSheet) },
                        modifier    = Modifier.fillMaxSize(),
                    )
                }
                else -> {
                    LazyColumn(
                        contentPadding      = PaddingValues(Dimens.SpacingLg),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                        modifier            = Modifier.fillMaxSize(),
                    ) {
                        items(state.drugs, key = { it.id }) { drug ->
                            DrugCard(
                                drug     = drug,
                                onEdit   = { viewModel.onEvent(DrugsEvent.OpenEditSheet(drug)) },
                                onDelete = { viewModel.onEvent(DrugsEvent.RequestDelete(drug.id)) },
                            )
                        }
                    }
                }
            }
        }

        // Bottom sheet.
        if (state.showSheet) {
            DrugFormSheet(
                isEditing  = state.editingDrug != null,
                form       = state.form,
                isSaving   = state.isSaving,
                saveError  = state.saveError,
                onField    = { field, value -> viewModel.onEvent(DrugsEvent.FieldChanged(field, value)) },
                onSave     = { viewModel.onEvent(DrugsEvent.Save) },
                onDismiss  = { viewModel.onEvent(DrugsEvent.DismissSheet) },
            )
        }

        // Delete confirm.
        if (state.showDeleteConfirm) {
            ConfirmDialog(
                title         = "Remove Drug",
                message       = "This drug will be removed from the formulary. Existing prescriptions referencing it will not be affected.",
                confirmLabel  = "Remove",
                isDestructive = true,
                onConfirm     = { viewModel.onEvent(DrugsEvent.ConfirmDelete) },
                onDismiss     = { viewModel.onEvent(DrugsEvent.DismissDelete) },
            )
        }
    }
}

// ─── Drug card ────────────────────────────────────────────────────────────────

@Composable
private fun DrugCard(
    drug: DrugItem,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text       = drug.name,
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                if (!drug.dosageForm.isNullOrBlank() || !drug.strength.isNullOrBlank()) {
                    Spacer(modifier = Modifier.height(Dimens.SpacingXs))
                    val subtitle = listOfNotNull(drug.dosageForm, drug.strength, drug.unit)
                        .joinToString(" · ")
                    if (subtitle.isNotBlank()) {
                        Text(
                            text  = subtitle,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
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
private fun DrugFormSheet(
    isEditing: Boolean,
    form: DrugFormState,
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
                text       = if (isEditing) "Edit Drug" else "New Drug",
                style      = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            HorizontalDivider()

            OutlinedTextField(
                value         = form.name,
                onValueChange = { onField("name", it) },
                label         = { Text("Drug Name *") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
            )

            // Dosage form dropdown.
            DosageFormSelector(
                selected     = form.dosageForm,
                onSelected   = { onField("dosageForm", it) },
                modifier     = Modifier.fillMaxWidth(),
            )

            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                OutlinedTextField(
                    value         = form.strength,
                    onValueChange = { onField("strength", it) },
                    label         = { Text("Strength") },
                    modifier      = Modifier.weight(1f),
                    singleLine    = true,
                )
                OutlinedTextField(
                    value         = form.unit,
                    onValueChange = { onField("unit", it) },
                    label         = { Text("Unit") },
                    modifier      = Modifier.weight(1f),
                    singleLine    = true,
                )
            }

            OutlinedTextField(
                value         = form.category,
                onValueChange = { onField("category", it) },
                label         = { Text("Category") },
                modifier      = Modifier.fillMaxWidth(),
                singleLine    = true,
            )

            OutlinedTextField(
                value         = form.sideEffects,
                onValueChange = { onField("sideEffects", it) },
                label         = { Text("Side Effects") },
                modifier      = Modifier.fillMaxWidth(),
                minLines      = 2,
                maxLines      = 4,
            )

            OutlinedTextField(
                value         = form.contraindications,
                onValueChange = { onField("contraindications", it) },
                label         = { Text("Contraindications") },
                modifier      = Modifier.fillMaxWidth(),
                minLines      = 2,
                maxLines      = 4,
            )

            if (saveError != null) {
                Text(
                    text  = saveError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            WellnessButton(
                text      = if (isEditing) "Update" else "Add Drug",
                onClick   = onSave,
                isLoading = isSaving,
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun DosageFormSelector(
    selected: String,
    onSelected: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }

    Box(modifier = modifier) {
        OutlinedTextField(
            value         = selected.ifBlank { "Select dosage form" },
            onValueChange = {},
            readOnly      = true,
            label         = { Text("Dosage Form") },
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
            DOSAGE_FORMS.forEach { form ->
                DropdownMenuItem(
                    text    = { Text(form) },
                    onClick = {
                        onSelected(form)
                        expanded = false
                    },
                )
            }
        }
    }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "DrugsScreen – loaded", showBackground = true)
@Composable
private fun DrugsScreenPreview() {
    WellnessTheme {
        LazyColumn(
            contentPadding      = PaddingValues(Dimens.SpacingLg),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            items(
                listOf(
                    DrugItem("1", "Metformin", "Tablet", "500", "mg", "Diabetes", null, null),
                    DrugItem("2", "Cetirizine", "Tablet", "10", "mg", "Allergy", "Drowsiness", "Alcohol"),
                    DrugItem("3", "Amoxicillin", "Capsule", "250", "mg", "Antibiotic", null, "Penicillin allergy"),
                )
            ) { drug ->
                DrugCard(drug = drug, onEdit = {}, onDelete = {})
            }
        }
    }
}
