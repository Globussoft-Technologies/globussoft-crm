package com.globussoft.wellness.feature.crm.presentation.approvals

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.Approval

private val TAB_LABELS = listOf("My Requests", "To Approve", "All")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ApprovalsScreen(
    viewModel: ApprovalsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    val pendingCount = state.approvals.count { it.isPending }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Approvals")
                        if (pendingCount > 0) {
                            Text(
                                text  = "$pendingCount pending",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            TabRow(selectedTabIndex = state.selectedTab) {
                TAB_LABELS.forEachIndexed { index, label ->
                    Tab(
                        selected = state.selectedTab == index,
                        onClick  = { viewModel.selectTab(index) },
                        text     = { Text(label) },
                    )
                }
            }

            PullToRefreshBox(
                isRefreshing = state.isLoading,
                onRefresh    = { viewModel.refresh() },
                modifier     = Modifier.fillMaxSize(),
            ) {
                when {
                    state.isLoading && state.approvals.isEmpty() -> {
                        ShimmerList(
                            itemCount = 5,
                            modifier  = Modifier.padding(Dimens.SpacingLg),
                        )
                    }
                    state.error != null -> {
                        ErrorState(
                            message  = state.error!!,
                            onRetry  = { viewModel.refresh() },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.approvals.isEmpty() -> {
                        EmptyState(
                            message  = "No approvals found",
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    else -> {
                        LazyColumn(
                            modifier            = Modifier.fillMaxSize(),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                            contentPadding      = PaddingValues(
                                horizontal = Dimens.SpacingLg,
                                vertical   = Dimens.SpacingSm,
                            ),
                        ) {
                            items(
                                items = state.approvals,
                                key   = { it.id },
                            ) { approval ->
                                ApprovalCard(
                                    approval  = approval,
                                    onApprove = { comment -> viewModel.approve(approval.id, comment) },
                                    onReject  = { comment -> viewModel.reject(approval.id, comment) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ApprovalCard(
    approval:  Approval,
    onApprove: (String?) -> Unit,
    onReject:  (String?) -> Unit,
    modifier:  Modifier = Modifier,
) {
    var showApproveDialog by remember(approval.id) { mutableStateOf(false) }
    var showRejectDialog  by remember(approval.id) { mutableStateOf(false) }
    var commentText       by remember(approval.id) { mutableStateOf("") }

    if (showApproveDialog) {
        AlertDialog(
            onDismissRequest = { showApproveDialog = false },
            title   = { Text("Approve Request?") },
            text    = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Optionally add a comment:")
                    OutlinedTextField(
                        value         = commentText,
                        onValueChange = { commentText = it },
                        placeholder   = { Text("Comment (optional)") },
                        modifier      = Modifier.fillMaxWidth(),
                        minLines      = 2,
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = { showApproveDialog = false; onApprove(commentText.ifBlank { null }) },
                    colors  = ButtonDefaults.buttonColors(containerColor = GenericAccent),
                ) { Text("Approve") }
            },
            dismissButton = { TextButton(onClick = { showApproveDialog = false }) { Text("Cancel") } },
        )
    }

    if (showRejectDialog) {
        AlertDialog(
            onDismissRequest = { showRejectDialog = false },
            title   = { Text("Reject Request?") },
            text    = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Please provide a reason:")
                    OutlinedTextField(
                        value         = commentText,
                        onValueChange = { commentText = it },
                        placeholder   = { Text("Reason (optional)") },
                        modifier      = Modifier.fillMaxWidth(),
                        minLines      = 2,
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = { showRejectDialog = false; onReject(commentText.ifBlank { null }) },
                    colors  = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                ) { Text("Reject") }
            },
            dismissButton = { TextButton(onClick = { showRejectDialog = false }) { Text("Cancel") } },
        )
    }
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
        ) {
            // Type + status chip
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text       = approval.type,
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                StatusBadge(status = approval.status)
            }

            // Requester → Approver
            val requester = approval.requesterName
            val approver  = approval.approverName
            if (!requester.isNullOrBlank() || !approver.isNullOrBlank()) {
                Spacer(Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = buildString {
                        if (!requester.isNullOrBlank()) append(requester)
                        if (!requester.isNullOrBlank() && !approver.isNullOrBlank()) append(" → ")
                        if (!approver.isNullOrBlank()) append(approver)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // Comments
            approval.comments?.takeIf { it.isNotBlank() }?.let { comment ->
                Spacer(Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = comment,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // Created date
            Spacer(Modifier.height(Dimens.SpacingXs))
            Text(
                text  = approval.createdAt ?: "",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            // Pending action buttons
            if (approval.isPending) {
                Spacer(Modifier.height(Dimens.SpacingMd))
                Row(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm)) {
                    Button(
                        onClick = { commentText = ""; showApproveDialog = true },
                        colors  = ButtonDefaults.buttonColors(
                            containerColor = GenericAccent,
                            contentColor   = Color.White,
                        ),
                    ) {
                        Text("Approve")
                    }
                    OutlinedButton(
                        onClick = { commentText = ""; showRejectDialog = true },
                        colors  = ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.error,
                        ),
                    ) {
                        Text("Reject")
                    }
                }
            }
        }
    }
}
