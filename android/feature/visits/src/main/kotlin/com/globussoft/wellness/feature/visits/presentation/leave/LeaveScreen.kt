package com.globussoft.wellness.feature.visits.presentation.leave

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.BeachAccess
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessDropdown
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.feature.visits.domain.model.LeaveRequest
import kotlinx.coroutines.launch

// ─── Public composable ────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LeaveScreen(
    viewModel: LeaveViewModel = hiltViewModel(),
) {
    val state        by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHost = remember { SnackbarHostState() }
    val scope        = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is LeaveEffect.ShowSnackbar -> scope.launch { snackbarHost.showSnackbar(effect.message) }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHost) },
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.BeachAccess, contentDescription = null,
                            tint = WellnessPrimary, modifier = Modifier.size(22.dp))
                        Spacer(Modifier.width(Dimens.SpacingSm))
                        Text("Leave", fontWeight = FontWeight.SemiBold)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                actions = {
                    WellnessButton(
                        text     = "Apply for Leave",
                        onClick  = { viewModel.onEvent(LeaveEvent.ShowApplySheet) },
                        icon     = Icons.Default.Add,
                        modifier = Modifier.padding(end = Dimens.SpacingMd),
                    )
                },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        when {
            state.isLoading && state.myRequests.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = WellnessPrimary, strokeWidth = 2.dp)
                }
            }
            state.error != null && state.myRequests.isEmpty() -> {
                ErrorState(
                    message  = state.error,
                    onRetry  = { viewModel.onEvent(LeaveEvent.Refresh) },
                    modifier = Modifier.fillMaxSize().padding(padding),
                )
            }
            else -> {
                LazyColumn(
                    modifier        = Modifier.fillMaxSize().padding(padding),
                    contentPadding  = androidx.compose.foundation.layout.PaddingValues(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                ) {
                    // My requests section
                    item {
                        Text("My Leave Requests",
                            style      = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }

                    if (state.myRequests.isEmpty()) {
                        item {
                            EmptyState(
                                message     = "No leave requests yet.\nTap 'Apply for Leave' to submit one.",
                                icon        = Icons.Default.BeachAccess,
                                actionLabel = "Apply for Leave",
                                onAction    = { viewModel.onEvent(LeaveEvent.ShowApplySheet) },
                                modifier    = Modifier.fillMaxWidth().height(160.dp),
                            )
                        }
                    } else {
                        item {
                            WellnessCard {
                                Column {
                                    state.myRequests.forEachIndexed { idx, req ->
                                        MyLeaveRequestRow(request = req)
                                        if (idx < state.myRequests.lastIndex) Divider(thickness = 0.5.dp)
                                    }
                                }
                            }
                        }
                    }

                    // All requests section — manager only
                    if (state.isManager && state.allRequests.isNotEmpty()) {
                        item { Spacer(Modifier.height(Dimens.SpacingSm)) }
                        item {
                            Text("All Leave Requests",
                                style      = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        item {
                            WellnessCard {
                                Column {
                                    state.allRequests.forEachIndexed { idx, req ->
                                        ManagerLeaveRequestRow(
                                            request      = req,
                                            isProcessing = state.processingId == req.id,
                                            onApprove    = { viewModel.onEvent(LeaveEvent.ApproveRequest(req.id)) },
                                            onReject     = { viewModel.onEvent(LeaveEvent.RejectRequest(req.id)) },
                                        )
                                        if (idx < state.allRequests.lastIndex) Divider(thickness = 0.5.dp)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Apply sheet
    if (state.showApplySheet) {
        ApplyLeaveSheet(state = state, onEvent = viewModel::onEvent)
    }
}

// ─── My leave request row ─────────────────────────────────────────────────────

@Composable
private fun MyLeaveRequestRow(request: LeaveRequest) {
    Row(
        modifier          = Modifier
            .fillMaxWidth()
            .padding(Dimens.SpacingMd),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text       = "${request.fromDate.take(10)} — ${request.toDate.take(10)}",
                style      = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs)) {
                StatusBadge(status = request.type)
                Text(
                    text  = request.reason,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        StatusBadge(status = request.status)
    }
}

// ─── Manager leave request row ────────────────────────────────────────────────

@Composable
private fun ManagerLeaveRequestRow(
    request: LeaveRequest,
    isProcessing: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    val isPending = request.status.uppercase() == "PENDING"

    Row(
        modifier          = Modifier
            .fillMaxWidth()
            .padding(Dimens.SpacingMd),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text       = request.employeeName ?: "Unknown",
                style      = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text  = "${request.fromDate.take(10)} — ${request.toDate.take(10)}",
                style = MaterialTheme.typography.bodySmall,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs)) {
                StatusBadge(status = request.type)
                Text(
                    text  = request.reason,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        if (isPending && !isProcessing) {
            IconButton(onClick = onApprove) {
                Icon(Icons.Default.Check, contentDescription = "Approve",
                    tint = WellnessSuccess, modifier = Modifier.size(20.dp))
            }
            IconButton(onClick = onReject) {
                Icon(Icons.Default.Close, contentDescription = "Reject",
                    tint = WellnessDanger, modifier = Modifier.size(20.dp))
            }
        } else if (isProcessing) {
            CircularProgressIndicator(color = WellnessPrimary, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
        } else {
            StatusBadge(status = request.status)
        }
    }
}

// ─── Apply leave bottom sheet ─────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ApplyLeaveSheet(
    state: LeaveUiState,
    onEvent: (LeaveEvent) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartialExpansion = true)
    val form       = state.applyForm
    val typeOptions = listOf(
        "ANNUAL" to "Annual Leave",
        "SICK"   to "Sick Leave",
        "UNPAID" to "Unpaid Leave",
    )

    ModalBottomSheet(
        onDismissRequest = { onEvent(LeaveEvent.DismissApplySheet) },
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
                text       = "Apply for Leave",
                style      = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm)) {
                WellnessTextField(
                    value         = form.fromDate,
                    onValueChange = { onEvent(LeaveEvent.FormFieldChanged("fromDate", it)) },
                    label         = "From Date *",
                    placeholder   = "2026-06-01",
                    isError       = form.fromDateError != null,
                    errorMessage  = form.fromDateError,
                    imeAction     = ImeAction.Next,
                    modifier      = Modifier.weight(1f),
                )
                WellnessTextField(
                    value         = form.toDate,
                    onValueChange = { onEvent(LeaveEvent.FormFieldChanged("toDate", it)) },
                    label         = "To Date *",
                    placeholder   = "2026-06-03",
                    isError       = form.toDateError != null,
                    errorMessage  = form.toDateError,
                    imeAction     = ImeAction.Next,
                    modifier      = Modifier.weight(1f),
                )
            }

            WellnessDropdown(
                value         = form.type,
                onValueChange = { onEvent(LeaveEvent.FormFieldChanged("type", it)) },
                label         = "Leave Type",
                options       = typeOptions,
            )

            WellnessTextField(
                value         = form.reason,
                onValueChange = { onEvent(LeaveEvent.FormFieldChanged("reason", it)) },
                label         = "Reason *",
                isError       = form.reasonError != null,
                errorMessage  = form.reasonError,
                singleLine    = false,
                maxLines       = 4,
                imeAction     = ImeAction.Done,
            )

            Spacer(Modifier.height(Dimens.SpacingSm))

            WellnessButton(
                text      = "Submit Request",
                onClick   = { onEvent(LeaveEvent.SubmitLeave) },
                isLoading = state.isSubmitting,
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}
