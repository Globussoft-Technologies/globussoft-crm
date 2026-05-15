package com.globussoft.wellness.feature.crm.presentation.channels

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

private val CHANNEL_TABS = listOf("SMS", "WhatsApp", "Telephony", "Push")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelsScreen(
    viewModel: ChannelsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Channels") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
    ) { paddingValues ->
        PullToRefreshBox(
            isRefreshing = state.isLoading,
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                TabRow(selectedTabIndex = state.selectedTab) {
                    CHANNEL_TABS.forEachIndexed { index, title ->
                        Tab(
                            selected = state.selectedTab == index,
                            onClick  = { viewModel.selectTab(index) },
                            text     = { Text(title) },
                        )
                    }
                }

                when {
                    state.isLoading && state.channels.isEmpty() -> {
                        ShimmerList(
                            itemCount = 4,
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
                    else -> {
                        val channelKey = when (state.selectedTab) {
                            0    -> "sms"
                            1    -> "whatsapp"
                            2    -> "telephony"
                            else -> "push"
                        }
                        @Suppress("UNCHECKED_CAST")
                        val channelData = state.channels[channelKey] as? Map<*, *>

                        if (channelData == null || channelData.isEmpty()) {
                            EmptyState(
                                message  = "No ${CHANNEL_TABS[state.selectedTab]} configuration found",
                                modifier = Modifier.fillMaxSize(),
                            )
                        } else {
                            ChannelConfigContent(
                                channelName = CHANNEL_TABS[state.selectedTab],
                                data        = channelData,
                                modifier    = Modifier
                                    .fillMaxSize()
                                    .verticalScroll(rememberScrollState())
                                    .padding(Dimens.SpacingLg),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ChannelConfigContent(
    channelName: String,
    data:        Map<*, *>,
    modifier:    Modifier = Modifier,
) {
    Column(
        modifier            = modifier,
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
    ) {
        WellnessCard(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
                Text(
                    text  = "$channelName Configuration",
                    style = MaterialTheme.typography.titleSmall,
                    color = GenericPrimary,
                )
                Spacer(Modifier.height(Dimens.SpacingMd))
                data.entries.forEachIndexed { index, (key, value) ->
                    ChannelRow(
                        label = key?.toString()?.replaceFirstChar { it.uppercase() } ?: "",
                        value = value?.toString() ?: "—",
                    )
                    if (index < data.entries.size - 1) {
                        HorizontalDivider(
                            modifier  = Modifier.padding(vertical = Dimens.SpacingXs),
                            thickness = 0.5.dp,
                            color     = MaterialTheme.colorScheme.outlineVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ChannelRow(
    label:    String,
    value:    String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier              = modifier
            .fillMaxWidth()
            .padding(vertical = Dimens.SpacingXs),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text     = label,
            style    = MaterialTheme.typography.bodySmall,
            color    = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        Text(
            text     = value,
            style    = MaterialTheme.typography.bodySmall,
            color    = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
    }
}
