package com.globussoft.wellness.feature.admin.presentation.marketing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
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
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.admin.domain.repository.CampaignItem

private val CHANNEL_FILTERS = listOf(
    null to "All", "EMAIL" to "Email", "SMS" to "SMS", "FORM" to "Forms",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MarketingScreen(viewModel: MarketingViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("SMS / Email Blasts", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        if (state.campaigns.isNotEmpty()) {
                            Text("${state.campaigns.size} campaigns", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.campaigns.isNotEmpty(),
            onRefresh    = viewModel::refresh,
            modifier     = Modifier.fillMaxSize().padding(padding),
        ) {
            when {
                state.isLoading && state.campaigns.isEmpty() ->
                    ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
                state.error != null && state.campaigns.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = viewModel::refresh, modifier = Modifier.fillMaxSize())
                else -> LazyColumn(
                    contentPadding      = PaddingValues(bottom = Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    modifier            = Modifier.fillMaxSize(),
                ) {
                    item {
                        LazyRow(
                            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                            contentPadding        = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingMd),
                        ) {
                            items(CHANNEL_FILTERS) { (value, label) ->
                                FilterChip(
                                    selected = state.selectedChannel == value,
                                    onClick  = { viewModel.setChannel(value) },
                                    label    = { Text(label) },
                                )
                            }
                        }
                    }
                    if (state.campaigns.isEmpty() && !state.isLoading) {
                        item { EmptyState(message = "No campaigns found.", icon = Icons.AutoMirrored.Filled.Send, modifier = Modifier.fillMaxWidth()) }
                    } else {
                        items(state.campaigns, key = { it.id }) { item ->
                            CampaignCard(item, modifier = Modifier.padding(horizontal = Dimens.SpacingLg))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CampaignCard(item: CampaignItem, modifier: Modifier = Modifier) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier              = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(item.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(item.channel, style = MaterialTheme.typography.bodySmall, color = WellnessPrimary)
                if (item.sent > 0) {
                    Text(
                        "Sent ${item.sent}  ·  Opened ${item.opened}  ·  Clicked ${item.clicked}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(item.createdAt.take(10), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                text       = item.status,
                style      = MaterialTheme.typography.labelSmall,
                color      = if (item.status == "Sent") WellnessPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}
