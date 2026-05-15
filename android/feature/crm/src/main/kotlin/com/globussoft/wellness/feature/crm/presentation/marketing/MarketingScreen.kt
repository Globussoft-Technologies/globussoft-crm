package com.globussoft.wellness.feature.crm.presentation.marketing

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.Campaign

private val TABS = listOf("All", "Email", "SMS")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MarketingScreen(
    viewModel: MarketingViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Marketing Campaigns") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick        = { viewModel.showCreate() },
                containerColor = GenericPrimary,
            ) {
                Icon(Icons.Default.Add, contentDescription = "New Campaign", tint = Color.White)
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            TabRow(selectedTabIndex = state.selectedTab) {
                TABS.forEachIndexed { index, title ->
                    Tab(
                        selected = state.selectedTab == index,
                        onClick  = { viewModel.selectTab(index) },
                        text     = { Text(title) },
                    )
                }
            }

            // Status filter chips
            val statusFilters = listOf(
                "All" to null,
                "Draft" to "DRAFT",
                "Scheduled" to "SCHEDULED",
                "Sent" to "SENT",
            )
            LazyRow(
                modifier              = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingXs),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
            ) {
                items(statusFilters) { filter ->
                    val label = filter.first
                    val value = filter.second
                    FilterChip(
                        selected = state.selectedStatus == value,
                        onClick  = { viewModel.setStatus(value) },
                        label    = { Text(label) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = GenericPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }

            PullToRefreshBox(
                isRefreshing = state.isLoading && state.campaigns.isNotEmpty(),
                onRefresh    = { viewModel.refresh() },
                modifier     = Modifier.fillMaxSize(),
            ) {
                when {
                    state.isLoading && state.campaigns.isEmpty() -> {
                        ShimmerList(
                            itemCount = 5,
                            modifier  = Modifier.fillMaxSize(),
                        )
                    }
                    state.error != null && state.campaigns.isEmpty() -> {
                        ErrorState(
                            message  = state.error ?: "Failed to load campaigns",
                            onRetry  = { viewModel.refresh() },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.campaigns.isEmpty() -> {
                        EmptyState(
                            message  = "No campaigns found.",
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    else -> {
                        LazyColumn(
                            contentPadding      = PaddingValues(
                                horizontal = Dimens.SpacingLg,
                                vertical   = Dimens.SpacingSm,
                            ),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                        ) {
                            items(state.campaigns, key = { it.id }) { campaign ->
                                CampaignCard(
                                    campaign  = campaign,
                                    onSendNow = { viewModel.sendNow(campaign.id) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (state.showCreateForm) {
        CampaignCreateSheet(
            isCreating = state.isCreating,
            formError  = state.formError,
            onDismiss  = { viewModel.dismissCreate() },
            onSave     = { name, channel, subject, body, scheduledAt ->
                viewModel.createCampaign(name, channel, subject, body, scheduledAt)
            },
        )
    }
}

@Composable
private fun CampaignCard(
    campaign: Campaign,
    onSendNow: () -> Unit = {},
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
        ) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text       = campaign.name,
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier   = Modifier.weight(1f),
                )
                ChannelChip(channel = campaign.channel)
            }

            Spacer(modifier = Modifier.height(6.dp))

            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                StatusChip(
                    label = campaign.status,
                    color = campaignStatusColor(campaign.status),
                )
                Text(
                    text  = "Audience: ${campaign.audienceSize}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (campaign.isSent || campaign.isScheduled) {
                Spacer(modifier = Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    campaign.openRate?.let { rate ->
                        MetricLabel(label = "Open", value = "${"%.1f".format(rate)}%")
                    }
                    campaign.clickRate?.let { rate ->
                        MetricLabel(label = "Click", value = "${"%.1f".format(rate)}%")
                    }
                }
            }

            val dateLabel = when {
                campaign.isSent      -> campaign.sentAt?.take(10)?.let { "Sent $it" }
                campaign.isScheduled -> campaign.scheduledAt?.take(10)?.let { "Scheduled $it" }
                else                 -> campaign.createdAt?.take(10)?.let { "Created $it" }
            }
            dateLabel?.let {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text  = it,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (campaign.status.uppercase() == "DRAFT") {
                TextButton(onClick = onSendNow) {
                    Text("Send Now", color = GenericPrimary, style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

@Composable
private fun ChannelChip(channel: String) {
    val color = when (channel.uppercase()) {
        "EMAIL" -> GenericPrimary
        "SMS"   -> Color(0xFF8B5CF6)
        else    -> Color(0xFF6B7280)
    }
    Box(
        modifier         = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(color.copy(alpha = 0.12f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text       = channel,
            style      = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Medium,
            color      = color,
        )
    }
}

@Composable
private fun StatusChip(label: String, color: Color) {
    SuggestionChip(
        onClick = {},
        label   = {
            Text(
                text  = label,
                style = MaterialTheme.typography.labelSmall,
            )
        },
        colors = SuggestionChipDefaults.suggestionChipColors(
            containerColor = color.copy(alpha = 0.15f),
            labelColor     = color,
        ),
        border = SuggestionChipDefaults.suggestionChipBorder(
            enabled     = true,
            borderColor = color.copy(alpha = 0.4f),
            borderWidth = 1.dp,
        ),
    )
}

@Composable
private fun MetricLabel(label: String, value: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text  = "$label:",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text       = value,
            style      = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color      = GenericAccent,
        )
    }
}

private fun campaignStatusColor(status: String): Color = when (status.uppercase()) {
    "SENT"      -> Color(0xFF10B981) // green
    "SCHEDULED" -> Color(0xFFF59E0B) // yellow
    else        -> Color(0xFF6B7280) // grey (DRAFT)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CampaignCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String, String, String, String) -> Unit,
) {
    var name        by remember { mutableStateOf("") }
    var channel     by remember { mutableStateOf("EMAIL") }
    var subject     by remember { mutableStateOf("") }
    var body        by remember { mutableStateOf("") }
    var scheduledAt by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier            = Modifier
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("New Campaign", style = MaterialTheme.typography.titleMedium)

            // Channel chips
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("EMAIL", "SMS", "WHATSAPP").forEach { ch ->
                    FilterChip(
                        selected = channel == ch,
                        onClick  = { channel = ch },
                        label    = { Text(ch) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = GenericPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }

            OutlinedTextField(
                value         = name,
                onValueChange = { name = it },
                label         = { Text("Campaign Name") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = subject,
                onValueChange = { subject = it },
                label         = { Text("Subject Line") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = body,
                onValueChange = { body = it },
                label         = { Text("Body / Message") },
                modifier      = Modifier.fillMaxWidth(),
                minLines      = 3,
            )
            OutlinedTextField(
                value         = scheduledAt,
                onValueChange = { scheduledAt = it },
                label         = { Text("Schedule (YYYY-MM-DD, optional)") },
                modifier      = Modifier.fillMaxWidth(),
            )

            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Button(
                onClick  = { onSave(name, channel, subject, body, scheduledAt) },
                enabled  = !isCreating && name.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating…" else "Create Campaign")
            }
        }
    }
}
