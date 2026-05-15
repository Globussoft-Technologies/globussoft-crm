package com.globussoft.wellness.feature.crm.presentation.sequences

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SequencesScreen(
    viewModel: SequencesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Sequences / Drip Campaigns") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.sequences.isNotEmpty(),
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            when {
                state.isLoading && state.sequences.isEmpty() -> {
                    ShimmerList(
                        itemCount = 6,
                        modifier  = Modifier.fillMaxSize(),
                    )
                }
                state.error != null && state.sequences.isEmpty() -> {
                    ErrorState(
                        message  = state.error ?: "Failed to load sequences",
                        onRetry  = { viewModel.refresh() },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.sequences.isEmpty() -> {
                    EmptyState(
                        message  = "No sequences found.",
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
                        items(state.sequences) { seq ->
                            val id = seq["id"] as? String ?: ""
                            SequenceRow(
                                seq        = seq,
                                isToggling = state.togglingId == id,
                                onToggle   = { viewModel.toggleActive(id, seq["isActive"] as? Boolean ?: false) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SequenceRow(
    seq: Map<String, Any>,
    isToggling: Boolean = false,
    onToggle: () -> Unit = {},
) {
    val name            = seq["name"] as? String ?: "Untitled"
    val isActive        = seq["isActive"] as? Boolean ?: false
    val enrollmentCount = seq["enrollmentCount"] as? Int ?: 0
    val steps           = seq["steps"]
    val stepCount       = when (steps) {
        is List<*> -> steps.size
        is Int     -> steps
        else       -> 0
    }

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text       = name,
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    modifier              = Modifier.padding(top = 4.dp),
                ) {
                    Text(
                        text  = "$enrollmentCount enrolled",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text  = "$stepCount steps",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(modifier = Modifier.width(8.dp))
            ActiveBadge(isActive = isActive, isToggling = isToggling, onClick = onToggle)
        }
    }
}

@Composable
private fun ActiveBadge(
    isActive: Boolean,
    isToggling: Boolean = false,
    onClick: () -> Unit = {},
) {
    val color = if (isActive) GenericAccent else Color(0xFF6B7280)
    val label = if (isActive) "ACTIVE" else "PAUSED"
    Box(
        modifier         = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(color.copy(alpha = 0.15f))
            .clickable(enabled = !isToggling) { onClick() }
            .padding(horizontal = 8.dp, vertical = 3.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (isToggling) {
            CircularProgressIndicator(
                modifier    = Modifier.size(12.dp),
                strokeWidth = 1.5.dp,
                color       = color,
            )
        } else {
            Text(
                text       = label,
                style      = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                color      = color,
            )
        }
    }
}
