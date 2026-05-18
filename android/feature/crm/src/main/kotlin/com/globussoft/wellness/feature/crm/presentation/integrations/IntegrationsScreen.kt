package com.globussoft.wellness.feature.crm.presentation.integrations

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IntegrationsScreen(
    viewModel: IntegrationsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Integrations") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.integrations.isNotEmpty(),
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            when {
                state.isLoading && state.integrations.isEmpty() -> ShimmerList(
                    itemCount = 5,
                    modifier  = Modifier.fillMaxSize(),
                )
                state.error != null && state.integrations.isEmpty() -> ErrorState(
                    message  = state.error!!,
                    onRetry  = { viewModel.refresh() },
                    modifier = Modifier.fillMaxSize(),
                )
                state.integrations.isEmpty() -> EmptyState(
                    message  = "No integrations configured.",
                    modifier = Modifier.fillMaxSize(),
                )
                else -> LazyColumn(
                    contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                ) {
                    items(state.integrations, key = { it["id"]?.toString() ?: it.hashCode().toString() }) { integration ->
                        IntegrationCard(integration = integration)
                    }
                }
            }
        }
    }
}

@Composable
private fun IntegrationCard(
    integration: Map<String, Any>,
    modifier: Modifier = Modifier,
) {
    val name      = integration["name"] as? String ?: integration["provider"] as? String ?: "Unknown"
    val status    = integration["status"] as? String ?: if (integration["isConnected"] as? Boolean == true) "connected" else "disconnected"
    val connected = status.lowercase() == "connected" || status.lowercase() == "active"

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = name, style = MaterialTheme.typography.titleSmall)
                SuggestionChip(
                    onClick = {},
                    label   = {
                        Text(
                            text  = if (connected) "Connected" else "Disconnected",
                            style = MaterialTheme.typography.labelSmall,
                            color = Color.White,
                        )
                    },
                    colors = SuggestionChipDefaults.suggestionChipColors(
                        containerColor = if (connected) GenericPrimary else MaterialTheme.colorScheme.outline,
                    ),
                    border = null,
                )
            }
            Button(
                onClick  = { /* non-functional placeholder */ },
                colors   = ButtonDefaults.buttonColors(
                    containerColor = if (connected) MaterialTheme.colorScheme.errorContainer else GenericPrimary,
                    contentColor   = if (connected) MaterialTheme.colorScheme.onErrorContainer else Color.White,
                ),
            ) {
                Text(if (connected) "Disconnect" else "Connect")
            }
        }
    }
}
