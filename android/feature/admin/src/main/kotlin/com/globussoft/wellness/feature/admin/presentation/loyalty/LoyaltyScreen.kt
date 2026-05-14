package com.globussoft.wellness.feature.admin.presentation.loyalty

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material3.ExperimentalMaterial3Api
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
import com.globussoft.wellness.feature.admin.domain.repository.LeaderboardEntry
import com.globussoft.wellness.feature.admin.domain.repository.ReferralItem

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoyaltyScreen(viewModel: LoyaltyViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Loyalty + Referrals", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && (state.leaderboard.isNotEmpty() || state.referrals.isNotEmpty()),
            onRefresh    = viewModel::refresh,
            modifier     = Modifier.fillMaxSize().padding(padding),
        ) {
            when {
                state.isLoading && state.leaderboard.isEmpty() && state.referrals.isEmpty() ->
                    ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
                state.error != null && state.leaderboard.isEmpty() && state.referrals.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = viewModel::refresh, modifier = Modifier.fillMaxSize())
                else -> Column(Modifier.fillMaxSize()) {
                    TabRow(selectedTabIndex = state.selectedTab) {
                        Tab(selected = state.selectedTab == 0, onClick = { viewModel.selectTab(0) }, text = { Text("Leaderboard") })
                        Tab(selected = state.selectedTab == 1, onClick = { viewModel.selectTab(1) }, text = { Text("Referrals (${state.referrals.size})") })
                    }
                    when (state.selectedTab) {
                        0 -> LeaderboardList(state.leaderboard)
                        1 -> ReferralsList(state.referrals)
                    }
                }
            }
        }
    }
}

@Composable
private fun LeaderboardList(entries: List<LeaderboardEntry>) {
    if (entries.isEmpty()) {
        EmptyState(message = "No loyalty data this month.", icon = Icons.Default.CardGiftcard, modifier = Modifier.fillMaxSize())
        return
    }
    LazyColumn(
        contentPadding      = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        modifier            = Modifier.fillMaxSize(),
    ) {
        itemsIndexed(entries, key = { _, e -> e.patientId }) { index, entry ->
            WellnessCard(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier              = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment     = Alignment.CenterVertically,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd)) {
                        Text(
                            text       = "#${index + 1}",
                            style      = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color      = WellnessPrimary,
                        )
                        Column {
                            Text(entry.patientName, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            if (!entry.phone.isNullOrBlank()) {
                                Text(entry.phone, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                    Text(
                        text       = "₹${"%,d".format(entry.earned)}",
                        style      = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        color      = WellnessPrimary,
                    )
                }
            }
        }
    }
}

@Composable
private fun ReferralsList(referrals: List<ReferralItem>) {
    if (referrals.isEmpty()) {
        EmptyState(message = "No referrals found.", icon = Icons.Default.CardGiftcard, modifier = Modifier.fillMaxSize())
        return
    }
    LazyColumn(
        contentPadding      = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        modifier            = Modifier.fillMaxSize(),
    ) {
        itemsIndexed(referrals, key = { _, r -> r.id }) { _, ref ->
            WellnessCard(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier              = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment     = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(ref.referredName, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        if (!ref.referredPhone.isNullOrBlank()) {
                            Text(ref.referredPhone, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (!ref.referrerName.isNullOrBlank()) {
                            Text("Referred by: ${ref.referrerName}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(ref.createdAt.take(10), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(ref.status, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (ref.rewardPoints > 0) {
                            Text("+${ref.rewardPoints} pts", style = MaterialTheme.typography.labelSmall, color = WellnessPrimary, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }
}
