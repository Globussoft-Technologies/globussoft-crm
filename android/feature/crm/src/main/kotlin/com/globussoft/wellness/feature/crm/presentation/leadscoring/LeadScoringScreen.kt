package com.globussoft.wellness.feature.crm.presentation.leadscoring

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens

private val ScoreGreen  = Color(0xFF22C55E)
private val ScoreOrange = Color(0xFFF97316)
private val ScoreRed    = Color(0xFFEF4444)

private fun scoreColor(score: Int): Color = when {
    score >= 70 -> ScoreGreen
    score >= 40 -> ScoreOrange
    else        -> ScoreRed
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LeadScoringScreen(
    viewModel: LeadScoringViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Lead Scoring") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
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
                state.isLoading && state.leads.isEmpty() -> ShimmerList(
                    itemCount = 5,
                    modifier  = Modifier.padding(Dimens.SpacingLg),
                )
                state.error != null -> ErrorState(
                    message  = state.error!!,
                    onRetry  = { viewModel.refresh() },
                    modifier = Modifier.fillMaxSize(),
                )
                state.leads.isEmpty() -> EmptyState(
                    message  = "No lead scores available",
                    modifier = Modifier.fillMaxSize(),
                )
                else -> LazyColumn(
                    modifier            = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                    contentPadding      = PaddingValues(
                        horizontal = Dimens.SpacingLg,
                        vertical   = Dimens.SpacingSm,
                    ),
                ) {
                    items(state.leads, key = { it["id"]?.toString() ?: it.hashCode().toString() }) { lead ->
                        LeadScoreCard(lead = lead)
                    }
                }
            }
        }
    }
}

@Composable
private fun LeadScoreCard(
    lead: Map<String, Any>,
    modifier: Modifier = Modifier,
) {
    val name  = lead["name"] as? String
        ?: lead["contactName"] as? String
        ?: lead["contact"] as? String
        ?: "Unknown"
    val score = (lead["score"] as? Number)?.toInt()
        ?: (lead["leadScore"] as? Number)?.toInt()
        ?: 0
    val color = scoreColor(score)

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = name, style = MaterialTheme.typography.titleSmall)
            }
            Box(
                modifier         = Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(color.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text  = "$score",
                    style = MaterialTheme.typography.titleSmall,
                    color = color,
                )
            }
        }
    }
}
