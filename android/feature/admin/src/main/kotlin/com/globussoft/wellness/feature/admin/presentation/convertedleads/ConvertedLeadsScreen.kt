package com.globussoft.wellness.feature.admin.presentation.convertedleads

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.admin.domain.repository.ConvertedLeadItem

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConvertedLeadsScreen(
    viewModel: ConvertedLeadsViewModel = hiltViewModel(),
    onNavigateBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    val displayed = if (state.searchQuery.isBlank()) {
        state.leads
    } else {
        val q = state.searchQuery.lowercase()
        state.leads.filter {
            it.name?.lowercase()?.contains(q) == true ||
            it.email?.lowercase()?.contains(q) == true ||
            it.phone?.contains(q) == true ||
            it.company?.lowercase()?.contains(q) == true
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Converted Leads", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        if (state.leads.isNotEmpty()) {
                            Text("${displayed.size} contacts", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
            OutlinedTextField(
                value         = state.searchQuery,
                onValueChange = viewModel::onSearch,
                placeholder   = { Text("Search by name, email, phone…") },
                leadingIcon   = { Icon(Icons.Default.Search, contentDescription = null) },
                singleLine    = true,
                modifier      = Modifier.fillMaxWidth().padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingXs),
            )
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
                    displayed.isEmpty() ->
                        EmptyState(message = "No converted leads found.", icon = Icons.Default.CheckCircle, modifier = Modifier.fillMaxSize())
                    else -> LazyColumn(
                        contentPadding      = PaddingValues(Dimens.SpacingLg),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                        modifier            = Modifier.fillMaxSize(),
                    ) {
                        items(displayed, key = { it.id }) { item ->
                            ConvertedLeadCard(item)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ConvertedLeadCard(item: ConvertedLeadItem) {
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
                val date = item.createdAt.take(10)
                if (date.isNotBlank()) {
                    Text("Converted $date", style = MaterialTheme.typography.bodySmall, color = WellnessPrimary)
                }
            }
            if (!item.source.isNullOrBlank()) {
                Text(
                    text       = item.source,
                    style      = MaterialTheme.typography.labelSmall,
                    color      = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}
