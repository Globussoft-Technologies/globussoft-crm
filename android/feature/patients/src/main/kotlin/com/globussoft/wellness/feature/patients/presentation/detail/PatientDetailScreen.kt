package com.globussoft.wellness.feature.patients.presentation.detail

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.LoadingScreen
import com.globussoft.wellness.core.designsystem.components.WellnessAvatar
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessTabStrip
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.core.domain.model.Patient
import com.globussoft.wellness.feature.patients.presentation.detail.tabs.CaseHistoryTab
import com.globussoft.wellness.feature.patients.presentation.detail.tabs.ConsentTab
import com.globussoft.wellness.feature.patients.presentation.detail.tabs.InventoryTab
import com.globussoft.wellness.feature.patients.presentation.detail.tabs.LogVisitTab
import com.globussoft.wellness.feature.patients.presentation.detail.tabs.MembershipsTab
import com.globussoft.wellness.feature.patients.presentation.detail.tabs.PhotosTab
import com.globussoft.wellness.feature.patients.presentation.detail.tabs.PrescriptionTab
import com.globussoft.wellness.feature.patients.presentation.detail.tabs.TelehealthTab
import com.globussoft.wellness.feature.patients.presentation.detail.tabs.TreatmentPlansTab
import com.globussoft.wellness.feature.patients.presentation.detail.tabs.WalletTab
import kotlinx.coroutines.launch

private val TABS = listOf(
    "Case History",
    "Prescription",
    "Consent",
    "Treatment Plans",
    "Log Visit",
    "Photos",
    "Inventory",
    "Telehealth",
    "Wallet",
    "Memberships",
)

// ─── Public composable ────────────────────────────────────────────────────────

/**
 * Patient detail screen hosting the 10-tab [HorizontalPager].
 *
 * @param patientId      Server-side UUID; resolved from the nav back-stack entry
 *                       by the navigation layer and forwarded to the ViewModel
 *                       via [SavedStateHandle].
 * @param onBack         Called when the user taps the back arrow (no-op when this
 *                       screen is rendered in the detail pane of a two-pane layout).
 * @param showBackButton Whether to display the back arrow in the TopAppBar.
 *                       `false` on tablets where the list pane is always visible.
 * @param viewModel      Hilt-injected [PatientDetailViewModel] (default).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PatientDetailScreen(
    patientId: String,
    onBack: () -> Unit,
    showBackButton: Boolean = true,
    viewModel: PatientDetailViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is PatientDetailEffect.ShowSnackbar -> scope.launch {
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
                        text  = state.patient?.name ?: "Patient Detail",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                },
                navigationIcon = {
                    if (showBackButton) {
                        IconButton(onClick = onBack) {
                            Icon(
                                imageVector        = Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = "Back",
                            )
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.onEvent(PatientDetailEvent.Refresh) }) {
                        Icon(
                            imageVector        = Icons.Default.Refresh,
                            contentDescription = "Refresh",
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        when {
            state.isLoading && state.patient == null -> {
                LoadingScreen(modifier = Modifier
                    .fillMaxSize()
                    .padding(contentPadding))
            }
            state.error != null && state.patient == null -> {
                ErrorState(
                    message  = state.error!!,
                    onRetry  = { viewModel.onEvent(PatientDetailEvent.Refresh) },
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(contentPadding),
                )
            }
            state.patient != null -> {
                PatientDetailContent(
                    state   = state,
                    onEvent = viewModel::onEvent,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(contentPadding),
                )
            }
        }
    }
}

// ─── Content ──────────────────────────────────────────────────────────────────

@Composable
private fun PatientDetailContent(
    state: PatientDetailUiState,
    onEvent: (PatientDetailEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val patient = state.patient!!
    val pagerState = rememberPagerState(
        initialPage = state.selectedTabIndex,
        pageCount   = { TABS.size },
    )

    // Keep ViewModel tab index in sync when the user swipes the pager.
    LaunchedEffect(pagerState) {
        snapshotFlow { pagerState.currentPage }.collect { page ->
            onEvent(PatientDetailEvent.TabSelected(page))
        }
    }

    // Keep the pager in sync when the ViewModel drives the tab selection.
    val scope = rememberCoroutineScope()
    LaunchedEffect(state.selectedTabIndex) {
        if (pagerState.currentPage != state.selectedTabIndex) {
            scope.launch { pagerState.scrollToPage(state.selectedTabIndex) }
        }
    }

    Column(modifier = modifier) {
        // Patient header card
        PatientHeaderCard(
            patient  = patient,
            modifier = Modifier.padding(Dimens.SpacingLg),
        )

        // Tab strip
        WellnessTabStrip(
            tabs          = TABS,
            selectedIndex = pagerState.currentPage,
            onTabSelected = { index ->
                scope.launch { pagerState.animateScrollToPage(index) }
                onEvent(PatientDetailEvent.TabSelected(index))
            },
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f))

        // Tab content via HorizontalPager
        HorizontalPager(
            state    = pagerState,
            modifier = Modifier.weight(1f),
        ) { page ->
            when (page) {
                0 -> CaseHistoryTab(visits = state.visits)
                1 -> PrescriptionTab(patient = patient)
                2 -> ConsentTab(patient = patient)
                3 -> TreatmentPlansTab(patient = patient)
                4 -> LogVisitTab(
                    state   = state,
                    onEvent = onEvent,
                )
                5 -> PhotosTab(patient = patient)
                6 -> InventoryTab(visits = state.visits)
                7 -> TelehealthTab(patient = patient)
                8 -> WalletTab(patient = patient)
                9 -> MembershipsTab(patient = patient)
            }
        }
    }
}

// ─── Header card ─────────────────────────────────────────────────────────────

@Composable
private fun PatientHeaderCard(
    patient: Patient,
    modifier: Modifier = Modifier,
) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                WellnessAvatar(name = patient.name, size = 56.dp)
                Spacer(Modifier.width(Dimens.SpacingMd))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text  = patient.name,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    val subtitle = buildString {
                        if (patient.age != null) append("${patient.age} yrs")
                        if (patient.dob != null) {
                            if (isNotEmpty()) append(" · ")
                            append(patient.dob.take(10))
                        }
                        if (!patient.gender.isNullOrBlank()) {
                            if (isNotEmpty()) append(" · ")
                            append(patient.gender)
                        }
                    }
                    if (subtitle.isNotBlank()) {
                        Text(
                            text  = subtitle,
                            style = MaterialTheme.typography.bodySmall,
                            color = WellnessTextSecondary,
                        )
                    }
                    Text(
                        text  = patient.phone,
                        style = MaterialTheme.typography.bodySmall,
                        color = WellnessTextSecondary,
                    )
                    if (!patient.email.isNullOrBlank()) {
                        Text(
                            text  = patient.email,
                            style = MaterialTheme.typography.bodySmall,
                            color = WellnessTextSecondary,
                        )
                    }
                }
            }

            // Stats row
            Spacer(Modifier.size(Dimens.SpacingMd))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StatChip(label = "Visits", value = patient.visitsCount.toString(), modifier = Modifier.weight(1f))
                StatChip(label = "Rx",     value = patient.rxCount.toString(),          modifier = Modifier.weight(1f))
                StatChip(label = "Plans",  value = patient.treatmentPlanCount.toString(), modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun StatChip(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier            = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text  = value,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            color = WellnessPrimary,
        )
        Text(
            text  = label,
            style = MaterialTheme.typography.labelSmall,
            color = WellnessTextSecondary,
        )
    }
}
