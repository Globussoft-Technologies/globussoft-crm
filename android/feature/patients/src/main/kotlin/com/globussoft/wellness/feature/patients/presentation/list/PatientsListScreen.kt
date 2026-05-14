package com.globussoft.wellness.feature.patients.presentation.list

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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.People
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.AdaptiveTwoPaneLayout
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessAvatar
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessDropdown
import com.globussoft.wellness.core.designsystem.components.WellnessSearchBar
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessAccent
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.core.domain.model.Patient
import com.globussoft.wellness.feature.patients.presentation.detail.PatientDetailScreen
import kotlinx.coroutines.launch

// ─── Public composable ────────────────────────────────────────────────────────

/**
 * Patients list screen with optional inline detail pane on tablets.
 *
 * On expanded windows (>= 840 dp) the list and detail pane are displayed
 * side-by-side via [AdaptiveTwoPaneLayout]. On compact / medium windows a
 * single pane is shown and [onNavigateToDetail] is called when the user taps
 * a patient card to push the detail screen onto the nav stack.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PatientsListScreen(
    onNavigateToDetail: (String) -> Unit,
    viewModel: PatientsListViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    // Mirror the 840 dp threshold used by AdaptiveTwoPaneLayout.
    val isExpanded = LocalConfiguration.current.screenWidthDp >= 840

    // Track which patient is "selected" in the two-pane tablet layout.
    var selectedPatientId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is PatientsListEffect.NavigateToDetail -> {
                    if (isExpanded) {
                        // Show detail inline in the right pane — no nav stack push.
                        selectedPatientId = effect.patientId
                    } else {
                        // Compact: push the detail screen onto the nav stack.
                        onNavigateToDetail(effect.patientId)
                    }
                }
                is PatientsListEffect.ShowSnackbar -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    AdaptiveTwoPaneLayout(
        showDetailPane   = selectedPatientId != null,
        listPane = {
            PatientsListPane(
                state         = state,
                snackbarHost  = snackbarHostState,
                onEvent       = viewModel::onEvent,
            )
        },
        detailPane = {
            if (selectedPatientId != null) {
                PatientDetailScreen(
                    patientId  = selectedPatientId!!,
                    onBack     = { selectedPatientId = null },
                    showBackButton = false,
                )
            }
        },
    )
}

// ─── List pane ────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PatientsListPane(
    state: PatientsListUiState,
    snackbarHost: SnackbarHostState,
    onEvent: (PatientsListEvent) -> Unit,
) {
    val listState = rememberLazyListState()

    // Trigger next-page load when the user is within 3 items of the list bottom.
    val shouldLoadMore by remember {
        derivedStateOf {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            val totalItems  = listState.layoutInfo.totalItemsCount
            !state.isLoading && !state.hasReachedEnd && totalItems > 0 && lastVisible >= totalItems - 3
        }
    }
    LaunchedEffect(shouldLoadMore) {
        if (shouldLoadMore) onEvent(PatientsListEvent.LoadNextPage)
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHost) },
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "Patients",
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                        if (state.totalCount > 0) {
                            Spacer(Modifier.width(Dimens.SpacingSm))
                            AssistChip(
                                onClick = {},
                                label = {
                                    Text(
                                        text  = "${state.totalCount}",
                                        style = MaterialTheme.typography.labelSmall,
                                    )
                                },
                                colors = AssistChipDefaults.assistChipColors(
                                    containerColor = WellnessPrimary.copy(alpha = 0.1f),
                                    labelColor     = WellnessPrimary,
                                ),
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { onEvent(PatientsListEvent.ToggleAddForm) },
                containerColor = WellnessPrimary,
            ) {
                Icon(
                    imageVector        = Icons.Default.Add,
                    contentDescription = "New Patient",
                    tint               = androidx.compose.ui.graphics.Color.White,
                )
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.patients.isNotEmpty(),
            onRefresh    = { onEvent(PatientsListEvent.Refresh) },
            modifier     = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                // Search bar
                WellnessSearchBar(
                    query         = state.searchQuery,
                    onQueryChange = { onEvent(PatientsListEvent.SearchChanged(it)) },
                    placeholder   = "Search patients by name or phone",
                    modifier      = Modifier.padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                )

                when {
                    state.isLoading && state.patients.isEmpty() -> {
                        ShimmerList(itemCount = 7, modifier = Modifier.fillMaxSize())
                    }
                    state.error != null && state.patients.isEmpty() -> {
                        ErrorState(
                            message  = state.error,
                            onRetry  = { onEvent(PatientsListEvent.Refresh) },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.patients.isEmpty() -> {
                        EmptyState(
                            message     = "No patients found.\nAdd your first patient to get started.",
                            icon        = Icons.Default.People,
                            actionLabel = "Add Patient",
                            onAction    = { onEvent(PatientsListEvent.ToggleAddForm) },
                            modifier    = Modifier.fillMaxSize(),
                        )
                    }
                    else -> {
                        LazyColumn(
                            state           = listState,
                            contentPadding  = PaddingValues(
                                horizontal = Dimens.SpacingLg,
                                vertical   = Dimens.SpacingSm,
                            ),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                            modifier = Modifier.weight(1f),
                        ) {
                            items(items = state.patients, key = { it.id }) { patient ->
                                PatientCard(
                                    patient = patient,
                                    onClick = { onEvent(PatientsListEvent.SelectPatient(patient)) },
                                    onEdit  = { onEvent(PatientsListEvent.EditPatient(patient)) },
                                )
                            }
                            // Pagination footer
                            if (state.isLoading && state.patients.isNotEmpty()) {
                                item {
                                    Box(
                                        modifier         = Modifier
                                            .fillMaxWidth()
                                            .padding(Dimens.SpacingLg),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        CircularProgressIndicator(
                                            color       = WellnessPrimary,
                                            strokeWidth = 2.dp,
                                            modifier    = Modifier.size(24.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Add / Edit ModalBottomSheet
        if (state.showAddForm) {
            PatientFormBottomSheet(
                state    = state,
                onEvent  = onEvent,
            )
        }
    }
}

// ─── Patient card ─────────────────────────────────────────────────────────────

@Composable
private fun PatientCard(
    patient: Patient,
    onClick: () -> Unit,
    onEdit: () -> Unit,
) {
    WellnessCard(
        modifier = Modifier.fillMaxWidth(),
        onClick  = onClick,
    ) {
        Row(
            modifier            = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            verticalAlignment   = Alignment.CenterVertically,
        ) {
            WellnessAvatar(name = patient.name, size = 44.dp)

            Spacer(Modifier.width(Dimens.SpacingMd))

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text  = patient.name,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text  = patient.phone,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val patientEmail = patient.email
                val patientSource = patient.source
                if (!patientEmail.isNullOrBlank()) {
                    Text(
                        text  = patientEmail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(Dimens.SpacingXs))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
                    verticalAlignment     = Alignment.CenterVertically,
                ) {
                    if (!patientSource.isNullOrBlank()) {
                        StatusBadge(status = patientSource)
                    }
                    Text(
                        text  = formatDate(patient.createdAt),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            IconButton(onClick = onEdit) {
                Icon(
                    imageVector        = Icons.Default.Edit,
                    contentDescription = "Edit patient",
                    tint               = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier           = Modifier.size(18.dp),
                )
            }
        }
    }
}

// ─── Add / Edit form bottom sheet ─────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PatientFormBottomSheet(
    state: PatientsListUiState,
    onEvent: (PatientsListEvent) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState()
    val isEditing  = state.editingPatient != null
    val form       = state.addForm

    val genderOptions = listOf(
        "male"              to "Male",
        "female"            to "Female",
        "other"             to "Other",
        "prefer_not_to_say" to "Prefer not to say",
    )
    val sourceOptions = listOf(
        "direct"       to "Direct Walk-In",
        "referral"     to "Referral",
        "social_media" to "Social Media",
        "google"       to "Google",
        "facebook"     to "Facebook",
        "instagram"    to "Instagram",
        "whatsapp"     to "WhatsApp",
        "other"        to "Other",
    )

    ModalBottomSheet(
        onDismissRequest = { onEvent(PatientsListEvent.ToggleAddForm) },
        sheetState       = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Dimens.SpacingLg)
                .padding(bottom = Dimens.SpacingHuge),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            Text(
                text  = if (isEditing) "Edit Patient" else "Add New Patient",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(bottom = Dimens.SpacingXs),
            )

            WellnessTextField(
                value         = form.name,
                onValueChange = { onEvent(PatientsListEvent.FormFieldChanged("name", it)) },
                label         = "Full Name *",
                isError       = form.nameError != null,
                errorMessage  = form.nameError,
                imeAction     = ImeAction.Next,
            )

            WellnessTextField(
                value         = form.phone,
                onValueChange = { onEvent(PatientsListEvent.FormFieldChanged("phone", it)) },
                label         = "Mobile Number *",
                isError       = form.phoneError != null,
                errorMessage  = form.phoneError,
                keyboardType  = KeyboardType.Phone,
                imeAction     = ImeAction.Next,
            )

            WellnessTextField(
                value         = form.email,
                onValueChange = { onEvent(PatientsListEvent.FormFieldChanged("email", it)) },
                label         = "Email (optional)",
                isError       = form.emailError != null,
                errorMessage  = form.emailError,
                keyboardType  = KeyboardType.Email,
                imeAction     = ImeAction.Next,
            )

            WellnessTextField(
                value         = form.dob,
                onValueChange = { onEvent(PatientsListEvent.FormFieldChanged("dob", it)) },
                label         = "Date of Birth (YYYY-MM-DD)",
                placeholder   = "1990-04-15",
                imeAction     = ImeAction.Next,
            )

            WellnessDropdown(
                value         = form.gender,
                onValueChange = { onEvent(PatientsListEvent.FormFieldChanged("gender", it)) },
                label         = "Gender",
                options       = genderOptions,
            )

            WellnessDropdown(
                value         = form.source,
                onValueChange = { onEvent(PatientsListEvent.FormFieldChanged("source", it)) },
                label         = "Source",
                options       = sourceOptions,
            )

            Spacer(Modifier.height(Dimens.SpacingSm))

            WellnessButton(
                text      = if (isEditing) "Save Changes" else "Save Patient",
                onClick   = { onEvent(PatientsListEvent.SubmitForm) },
                isLoading = state.isCreating,
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

private fun formatDate(isoDate: String): String = try {
    isoDate.substring(0, 10)
} catch (_: Exception) { isoDate }

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "PatientCard", showBackground = true)
@Composable
private fun PatientCardPreview() {
    WellnessTheme {
        PatientCard(
            patient = Patient(
                id                 = "1",
                name               = "Ramesh Kumar",
                phone              = "+91 98765 43210",
                email              = "ramesh@example.com",
                dob                = "1990-04-15",
                age                = 36,
                gender             = "Male",
                bloodGroup         = "B+",
                source             = "referral",
                locationId         = null,
                createdAt          = "2026-01-15T10:30:00.000Z",
                visitsCount        = 4,
                rxCount            = 2,
                treatmentPlanCount = 1,
            ),
            onClick = {},
            onEdit  = {},
        )
    }
}
