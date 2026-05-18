package com.globussoft.wellness.feature.crm.presentation.sharedinbox

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

private val statusFilters = listOf(
    Pair("All", null as String?),
    Pair("Open", "OPEN"),
    Pair("Resolved", "RESOLVED"),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SharedInboxScreen(
    viewModel: SharedInboxViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Shared Inbox") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        Column(modifier = Modifier.fillMaxSize().padding(contentPadding)) {
            LazyRow(
                contentPadding         = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                horizontalArrangement  = Arrangement.spacedBy(Dimens.SpacingSm),
            ) {
                items(statusFilters) { filter ->
                    FilterChip(
                        selected = state.selectedStatus == filter.second,
                        onClick  = { viewModel.setStatus(filter.second) },
                        label    = { Text(filter.first) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = GenericPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }

            PullToRefreshBox(
                isRefreshing = state.isLoading && state.conversations.isNotEmpty(),
                onRefresh    = { viewModel.refresh() },
                modifier     = Modifier.fillMaxSize(),
            ) {
                when {
                    state.isLoading && state.conversations.isEmpty() ->
                        ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
                    state.error != null && state.conversations.isEmpty() ->
                        ErrorState(message = state.error!!, onRetry = { viewModel.refresh() }, modifier = Modifier.fillMaxSize())
                    state.conversations.isEmpty() ->
                        EmptyState(message = "No conversations.", modifier = Modifier.fillMaxSize())
                    else ->
                        LazyColumn(
                            contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                        ) {
                            items(state.conversations) { conv ->
                                ConversationCard(
                                    conversation = conv,
                                    isAssigning  = state.assigningId == (conv["id"] as? String),
                                )
                            }
                        }
                }
            }
        }
    }
}

@Composable
private fun ConversationCard(
    conversation: Map<String, Any>,
    isAssigning: Boolean,
) {
    val subject    = conversation["subject"] as? String ?: conversation["title"] as? String ?: "No Subject"
    val from       = conversation["from"] as? String ?: conversation["contact"] as? String ?: "Unknown"
    val status     = conversation["status"] as? String ?: "OPEN"
    val assignee   = conversation["assignedTo"] as? String ?: conversation["assignee"] as? String
    val statusColor = if (status.uppercase() == "RESOLVED") Color(0xFF2E7D32) else Color(0xFFE65100)

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(subject, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(statusColor.copy(alpha = 0.15f))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                ) {
                    Text(status, style = MaterialTheme.typography.labelSmall, color = statusColor, fontWeight = FontWeight.Bold)
                }
            }
            Text("From: $from", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (assignee != null) {
                Text("Assigned to: $assignee", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
