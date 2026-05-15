package com.globussoft.wellness.feature.crm.presentation.settings

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
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CrmSettingsScreen(
    viewModel: CrmSettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("CRM Settings") },
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
            when {
                state.isLoading && state.settings.isEmpty() -> {
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
                else -> {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(Dimens.SpacingLg),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    ) {
                        SettingsSection(
                            title = "General",
                            items = listOf(
                                "Currency"         to state.settings["currency"]?.toString(),
                                "Timezone"         to state.settings["timezone"]?.toString(),
                                "Default Pipeline" to state.settings["defaultPipeline"]?.toString(),
                                "Email Retention"  to state.settings["emailRetention"]?.toString(),
                            ),
                        )
                        SettingsSection(
                            title = "Features",
                            items = listOf(
                                "Vertical"         to state.settings["vertical"]?.toString(),
                                "Locale"           to state.settings["locale"]?.toString(),
                                "Country"          to state.settings["country"]?.toString(),
                            ),
                        )
                        SettingsSection(
                            title = "Limits",
                            items = listOf(
                                "Rate Limit"       to state.settings["rateLimit"]?.toString(),
                                "Max Users"        to state.settings["maxUsers"]?.toString(),
                            ),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsSection(
    title: String,
    items: List<Pair<String, String?>>,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
            Text(
                text  = title,
                style = MaterialTheme.typography.titleSmall,
                color = GenericPrimary,
            )
            Spacer(Modifier.height(Dimens.SpacingMd))
            items.forEachIndexed { index, (label, value) ->
                SettingsRow(label = label, value = value ?: "—")
                if (index < items.lastIndex) {
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

@Composable
private fun SettingsRow(
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
            text  = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text  = value,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
