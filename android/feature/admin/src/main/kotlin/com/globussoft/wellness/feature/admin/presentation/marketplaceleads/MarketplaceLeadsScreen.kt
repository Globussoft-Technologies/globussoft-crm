package com.globussoft.wellness.feature.admin.presentation.marketplaceleads

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.feature.admin.domain.repository.MarketplaceLeadItem

private val PROVIDERS = listOf("All", "indiamart", "justdial", "tradeindia")
private val STATUSES  = listOf("All", "New", "Imported", "Duplicate", "Dismissed")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MarketplaceLeadsScreen(
    viewModel: MarketplaceLeadsViewModel = hiltViewModel(),
    onNavigateBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()

    val shouldLoadMore by remember {
        derivedStateOf {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            lastVisible >= state.leads.size - 5 && !state.isLoadingMore && state.currentPage < state.totalPages
        }
    }
    LaunchedEffect(shouldLoadMore) {
        if (shouldLoadMore) viewModel.loadNextPage()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Marketplace Leads", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        if (state.leads.isNotEmpty()) {
                            Text("${state.leads.size} loaded", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        Column(Modifier.fillMaxSize().padding(contentPadding)) {
            LazyRow(
                contentPadding        = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingXs),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
            ) {
                items(PROVIDERS) { p ->
                    val selected = state.providerFilter.let { if (it == null) p == "All" else it == p }
                    FilterChip(
                        selected = selected,
                        onClick  = { viewModel.setProviderFilter(if (p == "All") null else p) },
                        label    = { Text(p.replaceFirstChar { it.uppercase() }) },
                    )
                }
            }
            LazyRow(
                contentPadding        = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingXs),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
            ) {
                items(STATUSES) { s ->
                    val selected = state.statusFilter.let { if (it == null) s == "All" else it == s }
                    FilterChip(
                        selected = selected,
                        onClick  = { viewModel.setStatusFilter(if (s == "All") null else s) },
                        label    = { Text(s) },
                    )
                }
            }
            HorizontalDivider()

            PullToRefreshBox(
                isRefreshing = state.isLoading && state.leads.isNotEmpty(),
                onRefresh    = viewModel::refresh,
                modifier     = Modifier.fillMaxSize(),
            ) {
                when {
                    state.isLoading && state.leads.isEmpty() ->
                        ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
                    state.error != null && state.leads.isEmpty() ->
                        ErrorState(message = state.error!!, onRetry = viewModel::refresh, modifier = Modifier.fillMaxSize())
                    state.leads.isEmpty() ->
                        EmptyState(message = "No marketplace leads found.", icon = Icons.Default.Hub, modifier = Modifier.fillMaxSize())
                    else -> LazyColumn(
                        state               = listState,
                        contentPadding      = PaddingValues(Dimens.SpacingLg),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                        modifier            = Modifier.fillMaxSize(),
                    ) {
                        items(state.leads, key = { it.id }) { item ->
                            MarketplaceLeadCard(item)
                        }
                        if (state.isLoadingMore) {
                            item {
                                Box(Modifier.fillMaxWidth().padding(Dimens.SpacingMd), contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MarketplaceLeadCard(item: MarketplaceLeadItem) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier              = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.Top,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text       = item.name ?: "Unknown",
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(2.dp))
                val meta = buildList {
                    if (!item.phone.isNullOrBlank()) add(item.phone)
                    if (!item.company.isNullOrBlank()) add(item.company)
                }.joinToString(" · ")
                if (meta.isNotBlank()) {
                    Text(meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!item.email.isNullOrBlank()) {
                    Text(item.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text       = item.provider.replaceFirstChar { it.uppercase() },
                    style      = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    color      = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text  = item.status,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
