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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
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
                                CampaignCard(campaign = campaign)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CampaignCard(campaign: Campaign) {
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
